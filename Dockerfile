# --- Etapa 1: build del frontend React ---
FROM node:22-alpine AS frontend
WORKDIR /frontend
COPY frontend/package.json frontend/package-lock.json* ./
RUN npm install
COPY frontend/ ./
RUN npm run build

# --- Etapa 2: runtime backend FastAPI ---
FROM python:3.11-slim
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY backend/requirements.txt .
# The whole tree, not `backend/*.py`: a bare glob stops at the first level and
# silently drops every package directory. The unit suite runs on the working
# tree and would never notice — the image boots empty and dies on the first
# `import`. tests_architecture.py enforces this.
COPY backend/ /app/
RUN pip install --no-cache-dir -r requirements.txt
# Every top-level module at once. The previous explicit list had to be kept in
# sync with imports by hand, and twice it was not: settings.py once, history.py
# again. Globbing removes the failure mode instead of relying on memory.
COPY --from=frontend /frontend/dist /frontend/dist
COPY prototypes/ /app/prototypes/
ENV PORT=8000
EXPOSE ${PORT}
CMD uvicorn app:app --host 0.0.0.0 --port ${PORT}
