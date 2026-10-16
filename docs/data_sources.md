# Data sources

Every external dataset used by the project, what it is used for, and under which terms.
Rule (CLAUDE.md): public, synthetic, or consented data only. `data/` is never committed.

## CCPD2019 (Chinese City Parking Dataset)

| | |
|---|---|
| **Name** | CCPD2019, Chinese City Parking Dataset (Xu et al., ECCV 2018) |
| **URL** | https://github.com/detectRecog/CCPD (download links for `CCPD2019.tar.xz` are in its README) |
| **License** | The repository README says "open-source under MIT license", and its `LICENSE` file is MIT (© 2017 CCPD). **TODO (owner): verify this yourself in the CCPD README/LICENSE**, in particular that it covers the images, not only the code. |
| **Citation** | Xu, Z. et al. *Towards End-to-End License Plate Detection and Recognition: A Large Dataset and Baseline*. ECCV 2018. Required by the authors if the data is used. |
| **Usage** | **Plate DETECTOR pre-training only.** Never used to train or evaluate the OCR: the plates are Chinese (province character + Latin letters/digits), not Moroccan. Only the bounding box from each filename is used; the plate text is ignored. |
| **Local path** | `data/external/CCPD2019/` (images, subsets such as `ccpd_base`, `ccpd_weather`, ...); repository clone with README, LICENSE and split lists in `data/external/CCPD_repo/` |
| **Download date** | Repository cloned 2026-10-07 (from its git log). **TODO (owner): date the CCPD2019 images were downloaded** (not present in `data/external/` when this file was written). |
| **Prepared with** | `python scripts/prepare_detector_data.py --seed 0 [--preview]` → YOLO dataset in `data/detector/` with `plates.yaml`. Own seeded 80/10/10 split; the originals are hard-linked or copied, never modified. |

Notes:
- The photos show real vehicles and readable plate numbers. Keep them local, do not publish
  samples or previews, and delete `data/detector/` when it is no longer needed.
- A subset folder named `ccpd_np` contains images without plates; their filenames carry no
  annotation, so the converter skips them as malformed if that subset is selected.
