#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import time

from local_embeddings import (
    add_common_args,
    embedding_batch_size,
    embedding_device,
    encode_texts,
    load_sentence_transformer,
    runtime_card_rows,
    stale_or_missing_rows,
    write_embeddings,
)


def main() -> None:
    parser = argparse.ArgumentParser(description="Build local evidence-card embedding cache.")
    add_common_args(parser)
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()

    started = time.time()
    rows = runtime_card_rows()
    pending = stale_or_missing_rows(rows, args.model, args.limit)
    summary = {
        "model": args.model,
        "device": embedding_device(),
        "batchSize": embedding_batch_size(),
        "totalRuntimeEligibleCards": len(rows),
        "pendingCards": len(pending),
        "dryRun": args.dry_run,
    }
    if args.dry_run or not pending:
        summary["elapsedSeconds"] = round(time.time() - started, 2)
        print(json.dumps(summary, ensure_ascii=False, indent=2))
        return

    model = load_sentence_transformer(args.model, embedding_device())
    vectors = encode_texts(model, [text for _, text, _ in pending])
    write_embeddings(pending, vectors, args.model)
    summary.update(
        {
            "embeddedCards": len(vectors),
            "embeddingDim": len(vectors[0]) if vectors else 0,
            "elapsedSeconds": round(time.time() - started, 2),
        }
    )
    print(json.dumps(summary, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
