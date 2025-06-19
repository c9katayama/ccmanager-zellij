#!/bin/bash

# CCManager Update Script
set -e

echo "🔄 Updating CCManager..."

# Build the latest version
echo "📦 Building latest version..."
npm run build

# Check for linting issues
echo "🔍 Checking code quality..."
npm run lint

# Type check
echo "🔬 Type checking..."
npm run typecheck

# Set execute permissions and re-link the package
echo "🔗 Updating global link..."
chmod +x dist/cli.js
npm link

# Verify installation
echo "✅ Verifying installation..."
echo "Current version: $(ccmanager --version)"

echo "🎉 CCManager updated successfully!"
echo ""
echo "Usage:"
echo "  ccmanager           # Auto-launch with Zellij"
echo "  ccmanager --no-zellij  # Run directly"