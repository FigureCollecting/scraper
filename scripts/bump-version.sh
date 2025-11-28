#!/bin/bash
# Safe version bump script - prevents manual typo errors in package-lock.json
# Usage: ./scripts/bump-version.sh <version>
# Example: ./scripts/bump-version.sh 2.1.2

set -e

VERSION=$1

if [ -z "$VERSION" ]; then
    echo "❌ Error: Version argument required"
    echo "Usage: ./scripts/bump-version.sh <version>"
    echo "Example: ./scripts/bump-version.sh 2.1.2"
    exit 1
fi

# Validate semantic version format
if ! [[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[a-zA-Z0-9.]+)?$ ]]; then
    echo "❌ Error: Invalid version format: $VERSION"
    echo "Version must be in semver format (e.g., 1.2.3 or 1.2.3-beta.1)"
    exit 1
fi

echo "📦 Bumping version to $VERSION..."

# Use npm version to update both package.json and package-lock.json correctly
npm version "$VERSION" --no-git-tag-version

# Verify the change
PACKAGE_VERSION=$(node -pe "require('./package.json').version")
LOCKFILE_VERSION=$(node -pe "require('./package-lock.json').version")

if [ "$PACKAGE_VERSION" != "$VERSION" ]; then
    echo "❌ Error: package.json version mismatch"
    echo "Expected: $VERSION, Got: $PACKAGE_VERSION"
    exit 1
fi

if [ "$LOCKFILE_VERSION" != "$VERSION" ]; then
    echo "❌ Error: package-lock.json version mismatch"
    echo "Expected: $VERSION, Got: $LOCKFILE_VERSION"
    exit 1
fi

echo ""
echo "✅ Version successfully bumped to $VERSION"
echo ""
echo "📋 Files modified:"
echo "  - package.json (version: $PACKAGE_VERSION)"
echo "  - package-lock.json (version: $LOCKFILE_VERSION)"
echo ""
echo "🔍 Verification passed - both files are in sync"
echo ""
echo "Next steps:"
echo "  git add package.json package-lock.json"
echo "  git commit -m 'Bump version to $VERSION'"
