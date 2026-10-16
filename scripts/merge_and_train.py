import os
import random
import shutil
import subprocess
from pathlib import Path

def main():
    print("1. Preparing CCPD dataset...")
    subprocess.run([
        ".venv\\Scripts\\python", "scripts/prepare_detector_data.py", 
        "--src", "data\\external\\CCPD2019", 
        "--out", "data\\detector", 
        "--subsets", "ccpd_base", "ccpd_weather", 
        "--max-images", "2000", # using a smaller subset for speed
        "--overwrite"
    ], check=True)

    print("2. Merging Moroccan dataset...")
    moroccan_dir = Path("data/external/dataset/dataset")
    out_images = Path("data/detector/images")
    out_labels = Path("data/detector/labels")
    
    images = list(moroccan_dir.glob("*.jpg"))
    random.shuffle(images)
    
    # 80/10/10 split
    n = len(images)
    train_end = int(n * 0.8)
    val_end = int(n * 0.9)
    
    splits = {
        "train": images[:train_end],
        "val": images[train_end:val_end],
        "test": images[val_end:]
    }
    
    copied = 0
    for split, imgs in splits.items():
        for img in imgs:
            txt = img.with_suffix(".txt")
            if txt.exists():
                shutil.copy2(img, out_images / split / f"moroccan_{img.name}")
                shutil.copy2(txt, out_labels / split / f"moroccan_{txt.name}")
                copied += 1
                
    print(f"Merged {copied} Moroccan plates into the YOLO dataset.")

    print("3. Starting YOLO smoke training on CPU...")
    # Using smoke mode because CUDA is not available on this machine
    subprocess.run([
        ".venv\\Scripts\\python", "-m", "anpr.training.train_detector",
        "--mode", "smoke", 
        "--data", "data\\detector\\plates.yaml",
        "--epochs", "1"
    ], env={**os.environ, "PYTHONPATH": "src"}, check=True)
    
    print("All done! The smoke test finished successfully.")

if __name__ == "__main__":
    main()
