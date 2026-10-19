import { describe, expect, it } from "vitest";
import { DIRECTOR_TEMPLATES, getDirectorTemplate } from "./directorTemplates";
import type { DirectorProject } from "../schema/directorProject";

/** 模板里引用的素材必须都能在工程内解析到，否则套用后会出现空物体 */
function expectValidProject(project: DirectorProject) {
  const objectIds = new Set<string>();
  const assetIds = new Set(project.assets.map((asset) => asset.id));
  const cameraIds = new Set(project.cameras.map((camera) => camera.id));

  expect(project.version).toBe(1);
  expect(project.cameras.length).toBeGreaterThan(0);
  expect(project.activeCameraId).toBeTruthy();
  expect(cameraIds.has(String(project.activeCameraId))).toBe(true);

  project.objects.forEach((object) => {
    expect(objectIds.has(object.id)).toBe(false);
    objectIds.add(object.id);
    expect(Number.isFinite(object.transform.position[0])).toBe(true);
    expect(Number.isFinite(object.transform.scale[0])).toBe(true);
    expect(object.transform.scale.every((value) => value > 0)).toBe(true);
    if (object.assetRefId) {
      expect(assetIds.has(object.assetRefId)).toBe(true);
    }
    if (object.kind === "camera") {
      expect(cameraIds.has(String(object.linkedCameraId))).toBe(true);
    }
  });

  project.assets.forEach((asset) => {
    // 同一素材可以被多个物体引用（例如两段道路），这里只校验 URL 有效
    expect(asset.url).toBeTruthy();
  });
}

describe("director templates", () => {
  it("ports the director-desk preset scenes", () => {
    const ids = DIRECTOR_TEMPLATES.map((template) => template.id);

    expect(ids).toEqual([
      "bedroom",
      "room",
      "park",
      "street",
      "courtyard",
      "light-stage",
      "dolly-hall",
      "neon-chase",
      "abstract-stage",
      "blank",
    ]);
    expect(DIRECTOR_TEMPLATES.every((template) => template.detail.length > 0)).toBe(true);
  });

  it("builds a valid editable project for every template", () => {
    DIRECTOR_TEMPLATES.forEach((template) => {
      expectValidProject(template.build());
    });
  });

  it("keeps the blank template empty except for the camera", () => {
    const project = getDirectorTemplate("blank")!.build();

    expect(project.objects.filter((object) => object.kind !== "camera")).toHaveLength(0);
    expect(project.assets).toHaveLength(0);
    expect(project.cameras).toHaveLength(1);
  });

  it("fills the indoor and outdoor templates with editable assets", () => {
    const bedroom = getDirectorTemplate("bedroom")!.build();
    expect(bedroom.assets.length).toBeGreaterThanOrEqual(6);
    expect(bedroom.objects.filter((object) => object.kind === "character")).toHaveLength(4);

    const room = getDirectorTemplate("room")!.build();
    expect(room.assets.length).toBeGreaterThanOrEqual(5);

    const park = getDirectorTemplate("park")!.build();
    expect(park.objects.filter((object) => object.kind === "scene").length).toBeGreaterThanOrEqual(6);

    const street = getDirectorTemplate("street")!.build();
    expect(street.assets.length).toBeGreaterThanOrEqual(8);

    const courtyard = getDirectorTemplate("courtyard")!.build();
    expect(courtyard.objects.filter((object) => object.kind === "character")).toHaveLength(2);
  });

  it("uses primitives for the feature and abstract stages", () => {
    const lightStage = getDirectorTemplate("light-stage")!.build();
    expect(lightStage.objects.some((object) => object.geometryType === "cylinder")).toBe(true);

    const abstractStage = getDirectorTemplate("abstract-stage")!.build();
    expect(abstractStage.objects.filter((object) => object.geometryType).length).toBeGreaterThanOrEqual(4);
    expect(abstractStage.scene.showGround).toBe(false);
  });
});
