"""Offline JSON-lines bridge for a local Erlangshen-Roberta-330M-NLI snapshot."""

import argparse
import json
import os
import sys
from pathlib import Path

MODEL_ID = "IDEA-CCNL/Erlangshen-Roberta-330M-NLI"
LABELS = {"CONTRADICTION", "NEUTRAL", "ENTAILMENT"}
MAX_TOKENS = 256


def emit(value):
    sys.stdout.write(json.dumps(value, ensure_ascii=False, separators=(",", ":")) + "\n")
    sys.stdout.flush()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--model-path", required=True)
    args = parser.parse_args()
    model_path = Path(args.model_path).resolve()
    if not (model_path / "config.json").is_file() or not (model_path / "pytorch_model.bin").is_file():
        raise ValueError("local Erlangshen model snapshot is incomplete")
    os.environ["HF_HUB_OFFLINE"] = "1"
    os.environ["TRANSFORMERS_OFFLINE"] = "1"
    os.environ["TOKENIZERS_PARALLELISM"] = "false"
    import torch
    from transformers import AutoModelForSequenceClassification, AutoTokenizer

    torch.set_num_threads(min(4, os.cpu_count() or 1))
    tokenizer = AutoTokenizer.from_pretrained(model_path, local_files_only=True)
    model = AutoModelForSequenceClassification.from_pretrained(model_path, local_files_only=True).eval()
    id_to_label = {int(index): str(label).upper() for index, label in model.config.id2label.items()}
    if set(id_to_label.values()) != LABELS:
        raise ValueError("Erlangshen label mapping does not contain the three NLI labels")
    revision = model_path.name
    emit({"ready": True, "modelId": MODEL_ID, "modelRevision": revision, "maxTokens": MAX_TOKENS})

    for line in sys.stdin:
        request = None
        try:
            request = json.loads(line)
            request_id = request["id"]
            premise = request["premise"]
            hypothesis = request["hypothesis"]
            if not isinstance(request_id, str) or not request_id or not isinstance(premise, str) \
                    or not isinstance(hypothesis, str) or not premise.strip() or not hypothesis.strip() \
                    or len(premise) > 8000 or len(hypothesis) > 8000:
                raise ValueError("invalid NLI text pair")
            token_count = len(tokenizer([premise], [hypothesis], truncation=False)["input_ids"][0])
            tokens = tokenizer([premise], [hypothesis], truncation=True, max_length=MAX_TOKENS,
                               return_tensors="pt")
            with torch.inference_mode():
                values = model(**tokens).logits.softmax(dim=-1)[0].tolist()
            scores = {label: float(values[index]) for index, label in id_to_label.items()}
            label = max(scores, key=scores.get)
            emit({"id": request_id, "scores": scores, "label": label,
                  "truncated": token_count > MAX_TOKENS,
                  "modelId": MODEL_ID, "modelRevision": revision})
        except Exception as error:
            emit({"id": request.get("id") if isinstance(request, dict) else None,
                  "error": str(error)[:300]})


if __name__ == "__main__":
    main()
