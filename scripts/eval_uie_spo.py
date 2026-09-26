"""Compare PaddleNLP UIE models on a DuIE-style JSONL SPO dataset.

Example:
  python scripts/eval_uie_spo.py --model uie-mini --dataset D:/Models/UIE-mini/新测试集1.jsonl --home-path D:/Models/UIE-mini
"""

import argparse
import json
import time
from collections import defaultdict
from pathlib import Path


def value(item):
    return item.get("@value", "") if isinstance(item, dict) else item


def normalize(item):
    return str(value(item)).strip().strip("《》〈〉()（）【】[] ").strip()


def triples_from_prediction(prediction):
    triples = set()
    for subject_type, subjects in prediction.items():
        if not isinstance(subjects, list):
            raise ValueError(f"Expected subject list for {subject_type!r}: {subjects!r}")
        for subject in subjects:
            for predicate, objects in subject.get("relations", {}).items():
                for obj in objects:
                    triples.add(
                        (subject_type, normalize(subject["text"]), predicate, normalize(obj["text"]))
                    )
    return triples


def prf(tp, fp, fn):
    precision = tp / (tp + fp) if tp + fp else 0.0
    recall = tp / (tp + fn) if tp + fn else 0.0
    f1 = 2 * precision * recall / (precision + recall) if precision + recall else 0.0
    return {"precision": precision, "recall": recall, "f1": f1, "tp": tp, "fp": fp, "fn": fn}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--dataset", type=Path, required=True)
    parser.add_argument("--model", choices=("uie-mini", "uie-base"), required=True)
    parser.add_argument("--home-path", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--limit", type=int)
    parser.add_argument("--batch-size", type=int, default=8)
    args = parser.parse_args()

    samples = [json.loads(line) for line in args.dataset.read_text(encoding="utf-8").splitlines() if line.strip()]
    if args.limit is not None:
        samples = samples[: args.limit]
    schema_map = defaultdict(set)
    for sample in samples:
        for spo in sample["spo_list"]:
            schema_map[str(value(spo["subject_type"]))].add(spo["predicate"])
    schema = [{subject_type: sorted(predicates)} for subject_type, predicates in sorted(schema_map.items())]

    from paddlenlp import Taskflow

    started = time.monotonic()
    extractor = Taskflow(
        "information_extraction",
        schema=schema,
        model=args.model,
        home_path=str(args.home_path),
        batch_size=args.batch_size,
    )
    load_seconds = time.monotonic() - started
    started = time.monotonic()
    predictions = extractor([sample["text"] for sample in samples])
    inference_seconds = time.monotonic() - started
    if len(predictions) != len(samples):
        raise ValueError(f"Expected {len(samples)} predictions, got {len(predictions)}")

    totals = {"tp": 0, "fp": 0, "fn": 0}
    by_predicate = defaultdict(lambda: {"tp": 0, "fp": 0, "fn": 0})
    records = []
    for index, (sample, prediction) in enumerate(zip(samples, predictions), start=1):
        gold = {
            (
                str(value(spo["subject_type"])),
                normalize(spo["subject"]),
                spo["predicate"],
                normalize(spo["object"]),
            )
            for spo in sample["spo_list"]
        }
        predicted = triples_from_prediction(prediction)
        for category, entries in (("tp", predicted & gold), ("fp", predicted - gold), ("fn", gold - predicted)):
            totals[category] += len(entries)
            for entry in entries:
                by_predicate[entry[2]][category] += 1
        records.append(
            {
                "index": index,
                "text": sample["text"],
                "gold": sorted(map(list, gold)),
                "predicted": sorted(map(list, predicted)),
                "raw_prediction": prediction,
            }
        )

    report = {
        "model": args.model,
        "dataset": str(args.dataset),
        "sample_count": len(samples),
        "gold_triple_count": sum(len(record["gold"]) for record in records),
        "schema": schema,
        "load_seconds": load_seconds,
        "inference_seconds": inference_seconds,
        "overall": prf(**totals),
        "by_predicate": {name: prf(**stats) for name, stats in sorted(by_predicate.items())},
        "records": records,
    }
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps({key: val for key, val in report.items() if key != "records"}, ensure_ascii=False, indent=2))
    print(f"Report: {args.output}")


if __name__ == "__main__":
    main()
