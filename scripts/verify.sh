#!/usr/bin/env bash
# Pre-push verification: frontend build + backend tests
# Usage: ./scripts/verify.sh
set -euo pipefail

RED='\033[0;31m'
GREEN='\033[0;32m'
NC='\033[0m'

PASS=0
FAIL=0

echo "🔍 Verifying changes..."

# 1. Frontend TypeScript build
echo ""
echo "📦 Frontend build..."
if npm run build --prefix frontend 2>&1; then
  echo -e "${GREEN}✅ Frontend build OK${NC}"
  PASS=$((PASS + 1))
else
  echo -e "${RED}❌ Frontend build FAILED${NC}"
  FAIL=$((FAIL + 1))
fi

# 2. Backend tests
echo ""
echo "🧪 Backend tests..."
if python3 -m pytest backend/tests.py -q 2>&1; then
  echo -e "${GREEN}✅ Backend tests OK${NC}"
  PASS=$((PASS + 1))
else
  echo -e "${RED}❌ Backend tests FAILED${NC}"
  FAIL=$((FAIL + 1))
fi

# Summary
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
if [ $FAIL -eq 0 ]; then
  echo -e "${GREEN}✅ All checks passed ($PASS/$((PASS + FAIL)))${NC}"
  exit 0
else
  echo -e "${RED}❌ $FAIL check(s) failed ($PASS/$((PASS + FAIL)) passed)${NC}"
  exit 1
fi
