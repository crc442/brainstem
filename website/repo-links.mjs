import path from "node:path";
import { fileURLToPath } from "node:url";

// Docs are written to work on GitHub, so relative links point at repo files.
// On the site, links to other docs become /docs/ routes and everything else goes to GitHub.
export function repoLinksPlugin({ repoRoot, githubUrl, docsHref }) {
  const docsRoot = path.join(repoRoot, "docs");

  const rewriteUrl = (url, fileURL) => {
    if (/^([a-z][a-z+.-]*:|#|\/)/i.test(url)) return url;
    if (!fileURL) throw new Error(`Cannot resolve relative link "${url}" without a source file`);
    const [target, fragment] = url.split("#");
    const hash = fragment ? `#${fragment}` : "";
    const repoPath = path.resolve(path.dirname(fileURLToPath(fileURL)), target);
    const docsPath = path.relative(docsRoot, repoPath);
    if (!docsPath.startsWith("..") && docsPath.endsWith(".md")) return `${docsHref(docsPath.slice(0, -3))}${hash}`;
    return `${githubUrl}/blob/main/${path.relative(repoRoot, repoPath)}${hash}`;
  };

  return {
    name: "repo-links",
    link: (node, ctx) => ctx.setProperty(node, "url", rewriteUrl(node.url, ctx.fileURL)),
    definition: (node, ctx) => ctx.setProperty(node, "url", rewriteUrl(node.url, ctx.fileURL)),
  };
}
