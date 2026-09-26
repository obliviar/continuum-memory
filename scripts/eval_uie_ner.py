"""Evaluate UIE entity extraction on a reproducible JSONL sample."""

import argparse
import json
import random
import time
from collections import defaultdict
from pathlib import Path

from eval_uie_spo import prf


LABEL_MAP = {"PER": "人物", "LOC": "地点", "ORG": "组织机构"}
SCHEMA = list(LABEL_MAP.values())


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--dataset", type=Path, required=True)
    parser.add_argument("--model", choices=("uie-mini", "uie-base"), required=True)
    parser.add_argument("--home-path", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--sample-size", type=int, default=200)
    parser.add_argument("--seed", type=int, default=2026)
    parser.add_argument("--batch-size", type=int, default=16)
    args = parser.parse_args()

    all_samples = [json.loads(line) for line in args.dataset.read_text(encoding="utf-8").splitlines() if line.strip()]
    if args.sample_size < len(all_samples):
        indices = sorted(random.Random(args.seed).sample(range(len(all_samples)), args.sample_size))
    else:
        indices = list(range(len(all_samples)))
    samples = [all_samples[index] for index in indices]

    from paddlenlp import Taskflow

    started = time.monotonic()
    extractor = Taskflow(
        "information_extraction", schema=SCHEMA, model=args.model,
        home_path=str(args.home_path), batch_size=args.batch_size,
    )
    load_seconds = time.monotonic() - started
    started = time.monotonic()
    predictions = extractor([sample["text"] for sample in samples])
    inference_seconds = time.monotonic() - started
    if len(predictions) != len(samples):
        raise ValueError(f"Expected {len(samples)} predictions, got {len(predictions)}")

    totals = {"tp": 0, "fp": 0, "fn": 0}
    by_type = defaultdict(lambda: {"tp": 0, "fp": 0, "fn": 0})
    records = []
    for index, sample, prediction in zip(indices, samples, predictions):
        gold = {(LABEL_MAP[e["type"]], e["text"]) for e in sample["entities"]}
        predicted = {(label, item["text"]) for label, items in prediction.items() for item in items}
        for category, entries in (("tp", predicted & gold), ("fp", predicted - gold), ("fn", gold - predicted)):
            totals[category] += len(entries)
            for label, _ in entries:
                by_type[label][category] += 1
        records.append({"index": index + 1, "text": sample["text"], "gold": sorted(map(list, gold)), "predicted": sorted(map(list, predicted))})

    report = {
        "model": args.model,
        "dataset": str(args.dataset),
        "source_sample_count": len(all_samples),
        "sample_count": len(samples),
        "seed": args.seed,
        "gold_entity_count": sum(len(r["gold"]) for r in records),
        "load_seconds": load_seconds,
        "inference_seconds": inference_seconds,
        "overall": prf(**totals),
        "by_type": {label: prf(**by_type[label]) for label in SCHEMA},
        "records": records,
    }
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps({key: val for key, val in report.items() if key != "records"}, ensure_ascii=False, indent=2))
    print(f"Report: {args.output}")


if __name__ == "__main__":
    main()
