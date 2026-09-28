export const githubUrl = "https://github.com/crc442/brainstem";

export const installCommand = "bun add @brainstem/reflexes @brainstem/pi-adapter";

export const docsNav = [
  { id: "getting-started", label: "Getting started" },
  { id: "reflexes", label: "Reflexes" },
  { id: "integration/plugin", label: "Integration guide" },
  { id: "cli", label: "Reference CLI" },
];

export const docsSlug = (id: string) => (id === docsNav[0].id ? undefined : id);

export const docsHref = (id: string) => (docsSlug(id) ? `/docs/${id}/` : "/docs/");
