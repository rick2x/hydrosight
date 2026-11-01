# ==============================================================================
# Stage 1: Build the React + MapLibre GL + Tailwind Frontend
# ==============================================================================
FROM node:20-slim AS frontend-builder

WORKDIR /app/frontend
COPY frontend/package.json frontend/package-lock.json* ./
RUN npm install

COPY frontend/ ./
RUN npm run build

# ==============================================================================
# Stage 2: Python 3.11 + Geospatial Native Runtime + FastAPI Unified Server
# ==============================================================================
FROM python:3.11-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1

WORKDIR /app

# Install minimal system tools (rasterio, geopandas, pyproj, shapely all ship manylinux binary wheels)
RUN apt-get update && apt-get install -y --no-install-recommends \
    libexpat1 \
    curl \
    && rm -rf /var/lib/apt/lists/*

# Install Python backend dependencies
COPY backend/requirements.txt ./backend/requirements.txt
RUN pip install --upgrade pip && pip install -r backend/requirements.txt

# Copy backend source, spatial data, DEM rasters, and municipal boundaries
COPY backend/ ./backend/
COPY boundary/ ./boundary/
COPY dem/ ./dem/
COPY .env.example ./

# Copy compiled frontend static bundle from Stage 1
COPY --from=frontend-builder /app/frontend/dist ./frontend/dist

# Pre-warm spatial assets & sample photos during build so container startup is instant
RUN python -c "from backend.geo_engine import ensure_dem_exists, ensure_spatial_assets; from backend.meta_agents import ensure_sample_photos; ensure_dem_exists(); ensure_spatial_assets(); ensure_sample_photos()"

EXPOSE 8000

HEALTHCHECK --interval=15s --timeout=5s --start-period=10s --retries=3 \
    CMD curl -fsS http://127.0.0.1:8000/api/v1/health || exit 1

CMD ["python", "-m", "uvicorn", "backend.main:app", "--host", "0.0.0.0", "--port", "8000"]
