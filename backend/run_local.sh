#!/bin/bash
# Script to run the backend locally
export PYTHONPATH=/home/chan/projects/flow-controller/backend

case "${1:-run}" in
  test)
    python3 -m pytest tests.py -v
    ;;
  run|*)
    python3 -m uvicorn app:app --host 0.0.0.0 --port 8000 --reload
    ;;
esac
