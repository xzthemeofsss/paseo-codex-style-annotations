import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

const require = createRequire(process.argv[2] ? resolve(process.argv[2]) : import.meta.url);
const sharp = require("sharp");
const assets = fileURLToPath(new URL("../assets/", import.meta.url));

for (const name of ["preview", "workspace-sources", "draft-and-sent", "icon"]) {
  await sharp(resolve(assets, `${name}.svg`)).png().toFile(resolve(assets, `${name}.png`));
  console.log(`Exported assets/${name}.png`);
}
