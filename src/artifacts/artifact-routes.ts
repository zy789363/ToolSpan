import type { Express, Response } from "express";

import type { ArtifactRecord, ArtifactService } from "./artifact-service.js";

function sendArtifact(response: Response, artifact: ArtifactRecord, cacheControl: string): void {
  response
    .set("Cache-Control", cacheControl)
    .set("X-Content-Type-Options", "nosniff")
    .set("Content-Security-Policy", "default-src 'none'; sandbox")
    .set("Content-Disposition", `inline; filename="${artifact.profile}.artifact"`)
    .type(artifact.mediaType)
    .sendFile(artifact.filePath, (error) => {
      if (error === undefined) return;
      if (response.headersSent) {
        response.destroy(error);
      } else {
        response.status(404).end();
      }
    });
}

export function registerArtifactRoutes(app: Express, artifacts: ArtifactService): void {
  app.get("/artifacts/preview/:token", (request, response) => {
    void artifacts
      .resolvePreview(request.params.token ?? "")
      .then((artifact) => sendArtifact(response, artifact, "no-store"))
      .catch(() => response.status(404).json({ error: "Artifact preview not found" }));
  });

  app.get("/artifacts/published/:slug", (request, response) => {
    void artifacts
      .resolvePublished(request.params.slug ?? "")
      .then((artifact) => sendArtifact(response, artifact, "public, max-age=300"))
      .catch(() => response.status(404).json({ error: "Published artifact not found" }));
  });
}
