#!/usr/bin/env bash

set -e

echo "=================================="
echo " Updating NestJS Backend"
echo "=================================="

echo "[1/4] Pulling latest Git changes..."
git pull

echo "[2/4] Installing npm dependencies..."
npm install

echo "[3/4] Applying Prisma migrations..."
npx prisma migrate deploy

echo "[4/4] Starting NestJS development server..."
npm run start:dev
