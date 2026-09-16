#!/bin/bash
# Script to run the backend locally with hot-reload
export PYTHONPATH=/home/chan/projects/flow-controller/backend
python3 -m uvicorn app:app --host 0.0.0.0 --port 8000 --reload