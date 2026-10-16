# ANPR Secure: Moroccan plate recognition + cybersecurity

## Goal
Secure AI-powered ANPR platform for a cybersecurity engineer interview.

## Stack
Python 3.11, PyTorch, Ultralytics YOLO, FastAPI, PostgreSQL, pytest, Ruff.

## Layout
src/anpr/{data,models,training,pipeline,security,api,db,utils}, tests/, configs/, docs/

## Moroccan plate format
Canonical form: `number|letter|region` (1-5 digits, one Arabic letter, region 1-2 digits).
Letter set and region range live in configs/plate_format.yaml (verify against official rules).

## Rules
- Run with the .venv activated; use `python -m pip`.
- Every module gets pytest tests.
- Public, synthetic, or consented data only. Never commit data/ or model weights.
- Security code (signing, auth, audit) must be simple and explainable.
- A human confirms every watchlist match.