#!/bin/bash
# Pre-push verification: frontend build + backend tests
# Usage: ./scripts/verify.sh
set -e

echo "🔍 Verifying changes..."

# 1. Frontend TypeScript build
echo ""
echo "📦 Frontend build..."
cd frontend && npm run build
cd ..

# 2. Backend tests
echo ""
echo "🧪 Backend tests..."
python3 -m pytest backend/tests.py -q

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "✅ All checks passed"
