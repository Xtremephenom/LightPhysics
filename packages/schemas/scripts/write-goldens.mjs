import { writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { generateCoreApiJsonSchemaGolden, stringifyCoreApiJsonSchemaGolden } from "../src/core-api-goldens.ts";

const output = fileURLToPath(new URL("../goldens/core-api.json", import.meta.url));
await writeFile(output, stringifyCoreApiJsonSchemaGolden(generateCoreApiJsonSchemaGolden()), "utf8");
console.log(`wrote ${output}`);
