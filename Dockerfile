# --- Etapa 1: build del frontend React ---
FROM node:22-alpine AS frontend
WORKDIR /frontend
COPY frontend/package.json frontend/package-lock.json* ./
RUN npm install
COPY frontend/ ./
RUN npm run build

# --- Etapa 2: runtime backend FastAPI ---
FROM python:3.11-slim
WORKDIR /app
COPY backend/requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY backend/app.py .
COPY backend/config.py .
COPY backend/clients.py .
COPY backend/traces.py .
COPY backend/copy_engine.py .
COPY backend/tests.py .
COPY --from=frontend /frontend/dist /frontend/dist
COPY prototypes/ /app/prototypes/
ENV PORT=8000
EXPOSE ${PORT}
CMD uvicorn app:app --host 0.0.0.0 --port ${PORT}
