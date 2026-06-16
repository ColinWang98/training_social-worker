#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json

from local_embeddings import add_common_args, embedding_stats


def main() -> None:
    parser = argparse.ArgumentParser(description="Report local embedding cache coverage.")
    add_common_args(parser)
    args = parser.parse_args()
    print(json.dumps(embedding_stats(args.model), ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
