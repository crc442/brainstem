import { defineConfig } from "astro/config";
import { satteri } from "@astrojs/markdown-satteri";
import { fileURLToPath } from "node:url";
import { repoLinksPlugin } from "./repo-links.mjs";
import { docsHref, githubUrl } from "./src/site.ts";

export default defineConfig({
  site: "https://brainstem.sh",
  markdown: {
    shikiConfig: { themes: { light: "github-light", dark: "github-dark" } },
    processor: satteri({
      mdastPlugins: [
        repoLinksPlugin({
          repoRoot: fileURLToPath(new URL("..", import.meta.url)),
          githubUrl,
          docsHref,
        }),
      ],
    }),
  },
});
