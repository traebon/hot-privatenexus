import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __dirname = dirname(fileURLToPath(import.meta.url));

// Single source of truth for the served version -- package.json is the one
// version file guaranteed to be inside the image (COPY app/backend/ ./
// carries it; the root VERSION file used by scripts/install.sh is not).
export const PACKAGE_VERSION = JSON.parse(readFileSync(join(__dirname, "../package.json"), "utf8")).version;
