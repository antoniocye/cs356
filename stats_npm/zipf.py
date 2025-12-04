import json
import sys
from pathlib import Path
import numpy as np
import matplotlib.pyplot as plt


def load_downloads(json_path: str) -> list[int]:
    path = Path(json_path)
    if not path.exists():
        raise FileNotFoundError(f"File not found: {json_path}")

    with path.open("r", encoding="utf-8") as f:
        data = json.load(f)

    downloads = [int(entry[0]) for entry in data]

    downloads.sort(reverse=True)
    return downloads

def zipf_top():
    json_path = "../output_files_top_1000/top1000.json"

    downloads = load_downloads(json_path)

    ranks = range(1, len(downloads) + 1)

    plt.figure(figsize=(8, 5))
    plt.plot(ranks, downloads, marker="o", linestyle="none", markersize=4)

    plt.xlabel("Rank (1 = most downloaded)")
    plt.ylabel("Downloads")
    plt.title("Random 1000 npm packages: Rank frequency distribution of downloads")
    plt.grid(True, alpha=0.3)
    plt.tight_layout()
    plt.show()


def zipf_random() -> None:
    # json_path = "../output_file_random_1000/random1000.json"
    json_path = "../output_files_top_1000/top1000.json"
    path = Path(json_path)
    with path.open("r", encoding="utf-8") as f:
        data = json.load(f)

    # extract download counts
    downloads = np.array([int(row[0]) for row in data], dtype=int)

    zeros = int((downloads == 0).sum())
    positive = downloads[downloads > 0]

    print(f"Total packages: {len(downloads)}")
    print(f"Packages with 0 downloads: {zeros}")
    print(f"Packages with > 0 downloads: {len(positive)}")

    if positive.size == 0:
        raise SystemExit("No packages with downloads > 0, nothing to plot.")

    # histogram of positive downloads, log-spaced bins
    min_pos = positive.min()
    max_pos = positive.max()
    bins = np.logspace(np.log10(min_pos), np.log10(max_pos), 30)

    mean_downloads = positive.mean()
    print(f"Mean downloads (among > 0): {mean_downloads:.2f}")

    plt.figure(figsize=(8, 5))
    plt.hist(positive, bins=bins)

    # vertical line at the mean
    plt.axvline(mean_downloads, linestyle="--", linewidth=2,
                label=f"Mean = {mean_downloads:.0f}")

    plt.xscale("log")
    plt.xlabel("Downloads (log scale)")
    plt.ylabel("Number of packages")
    plt.title("Distribution of downloads for the top 1000 npm packages")
    plt.grid(True, which="both", alpha=0.3)
    plt.legend()
    plt.tight_layout()
    plt.show()


def main():
    zipf_random()


if __name__ == "__main__":
    main()
