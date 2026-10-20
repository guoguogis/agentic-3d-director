import { Euler, Matrix4, Quaternion, Vector3 } from "three";
import { getModelLibraryItems, type ModelLibraryCategoryId } from "../modelLibrary/modelLibraryCatalog";
import { getCameraRigPositionFromViewSnapshot } from "../schema/cameraGeometry";
import type {
  CharacterBodyType,
  DirectorAssetRef,
  DirectorCameraShot,
  DirectorObject,
  DirectorProject,
  DirectorTransform,
  GeometryPrimitiveType,
  SceneSettings,
} from "../schema/directorProject";
import {
  createDefaultDirectorTimeline,
  createTrajectoryTrack,
  type DirectorTrajectoryWaypoint,
} from "../timeline/animationTimeline";
import { DEFAULT_SCENE } from "../store/directorStore";

export type DirectorTemplateCategory = "室内" | "室外" | "特色" | "抽象" | "自由搭建";

export interface DirectorTemplate {
  id: string;
  name: string;
  category: DirectorTemplateCategory;
  detail: string;
  build: () => DirectorProject;
}

type Vec3 = [number, number, number];

const CHARACTER_COLORS = ["#4F8EF7", "#E0524D", "#F2A900", "#12B886", "#9C4DCC", "#00B8D9"];

function toTransform(position: Vec3, rotationY = 0, scale: number | Vec3 = 1): DirectorTransform {
  return {
    position,
    rotation: [0, rotationY, 0],
    scale: typeof scale === "number" ? [scale, scale, scale] : scale,
  };
}

/** 相机机身朝向：与视口拖拽相机时的 lookAt 逻辑保持一致 */
function cameraRotation(position: Vec3, target: Vec3): Vec3 {
  const origin = new Vector3(...position);
  const forward = new Vector3(...target).sub(origin);
  if (forward.lengthSq() === 0) return [0, 0, 0];
  forward.normalize();
  const up =
    Math.abs(forward.dot(new Vector3(0, 1, 0))) > 0.999
      ? new Vector3(0, 0, 1)
      : new Vector3(0, 1, 0);
  const matrix = new Matrix4().lookAt(origin, origin.clone().sub(forward), up);
  const euler = new Euler().setFromQuaternion(new Quaternion().setFromRotationMatrix(matrix));
  return [euler.x, euler.y, euler.z];
}

let libraryIndex: Map<string, ReturnType<typeof getModelLibraryItems>[number]> | null = null;

function findLibraryItem(categoryId: ModelLibraryCategoryId, fileName: string) {
  if (!libraryIndex) {
    libraryIndex = new Map(
      getModelLibraryItems().map((item) => [`${item.categoryId}:${item.fileName}`, item])
    );
  }
  return libraryIndex.get(`${categoryId}:${fileName}`) ?? null;
}

interface LibraryObjectOptions {
  categoryId: ModelLibraryCategoryId;
  fileName: string;
  name: string;
  kind?: "scene" | "prop";
  position: Vec3;
  rotationY?: number;
  /** 在真实尺寸基础上的额外倍率（墙 / 道路这类需要拉长的素材用） */
  scale?: number;
}

/**
 * 模板自带的演示动画：套用后时间轴里直接有轨道，可以播放并导出视频。
 * 预置模板本身只读 —— 每次 build 都重新创建对象与轨道，改场景不会污染模板。
 */
interface TemplateAnimationOptions {
  durationSec?: number
  /** 机位运动：推近 / 环绕 / 不动 */
  camera?: "push-in" | "orbit" | "none"
  /** 角色运动：行走 / 奔跑 / 不动 */
  characterMotion?: "walk" | "run" | "none"
  /** 带运动的角色数量（从模板里前几个角色开始） */
  characterCount?: number
  /** 角色移动方向轴 */
  characterAxis?: "x" | "z"
}

const DEFAULT_TEMPLATE_ANIMATION: Required<TemplateAnimationOptions> = {
  durationSec: 8,
  camera: "push-in",
  characterMotion: "none",
  characterCount: 0,
  characterAxis: "x",
}

function createProjectBuilder(
  scenePatch: Partial<SceneSettings> = {},
  animationPatch: TemplateAnimationOptions = {},
) {
  const animation = { ...DEFAULT_TEMPLATE_ANIMATION, ...animationPatch };
  const project: DirectorProject = {
    version: 1,
    scene: { ...DEFAULT_SCENE, ...scenePatch },
    assets: [],
    objects: [],
    cameras: [],
    activeCameraId: null,
    panoramaAssetId: null,
    timeline: createDefaultDirectorTimeline(),
  };

  const nextObjectId = () => `obj_${project.objects.length + 1}`;
  const cameraObjectIds: string[] = [];
  const characterObjectIds: string[] = [];

  function addLibraryObject(options: LibraryObjectOptions) {
    const item = findLibraryItem(options.categoryId, options.fileName);
    if (!item) return null;

    const assetId = `asset_${project.assets.length + 1}`;
    const asset: DirectorAssetRef = {
      id: assetId,
      kind: options.kind ?? "prop",
      sourceType: "model",
      fileName: item.fileName,
      name: options.name,
      url: item.url,
      assetSource: "library",
    };
    project.assets.push(asset);

    // 导入模型会被场景归一化到 2m，这里按素材真实最大尺寸还原
    const baseScale = item.size ? item.size / 2 : 1;
    project.objects.push({
      id: nextObjectId(),
      name: options.name,
      kind: asset.kind,
      visible: true,
      locked: false,
      assetRefId: assetId,
      transform: toTransform(options.position, options.rotationY ?? 0, baseScale * (options.scale ?? 1)),
    });
    return assetId;
  }

  function addPrimitive(options: {
    name: string;
    geometryType: GeometryPrimitiveType;
    position: Vec3;
    rotationY?: number;
    scale: number | Vec3;
    color: string;
  }) {
    project.objects.push({
      id: nextObjectId(),
      name: options.name,
      kind: "prop",
      visible: true,
      locked: false,
      geometryType: options.geometryType,
      color: options.color,
      transform: toTransform(options.position, options.rotationY ?? 0, options.scale),
    });
  }

  function addCharacter(options: {
    name: string;
    position: Vec3;
    rotationY?: number;
    pose?: string;
    bodyType?: CharacterBodyType;
    color?: string;
  }) {
    const color = options.color ?? CHARACTER_COLORS[project.objects.filter((item) => item.kind === "character").length % CHARACTER_COLORS.length];
    const objectId = nextObjectId();
    characterObjectIds.push(objectId);
    project.objects.push({
      id: objectId,
      name: options.name,
      kind: "character",
      visible: true,
      locked: false,
      bodyType: options.bodyType ?? "mannequin",
      color,
      transform: toTransform(options.position, options.rotationY ?? 0),
      characterRig: {
        rigType: "ue4-mannequin",
        posePresetId: options.pose ?? "stand",
        controls: {},
      },
    });
  }

  function addCamera(options: { name: string; view: Vec3; target: Vec3; fov?: number }) {
    const fov = options.fov ?? 40;
    const rigPosition = getCameraRigPositionFromViewSnapshot({
      fov,
      position: options.view,
      target: options.target,
    });
    const rotation = cameraRotation(rigPosition, options.target);
    const cameraId = `cam_${project.cameras.length + 1}`;
    const camera: DirectorCameraShot = {
      id: cameraId,
      name: options.name,
      fov,
      transform: { position: rigPosition, rotation, scale: [1, 1, 1] },
      targetMode: "manual",
      target: options.target,
      lastCaptureUrl: null,
      captures: [],
    };
    project.cameras.push(camera);
    const cameraObjectId = `cam_object_${project.cameras.length}`;
    cameraObjectIds.push(cameraObjectId);
    project.objects.push({
      id: cameraObjectId,
      name: options.name,
      kind: "camera",
      visible: true,
      locked: false,
      linkedCameraId: cameraId,
      transform: { position: rigPosition, rotation, scale: [1, 1, 1] },
    });
    if (!project.activeCameraId) project.activeCameraId = cameraId;
  }

  /** 机位轨道：推近或环绕，保证套用模板后时间轴不是空的 */
  function buildCameraTrack(): DirectorTrajectoryWaypoint[] {
    const object = project.objects.find((item) => item.id === cameraObjectIds[0]);
    const camera = project.cameras.find((item) => item.id === object?.linkedCameraId) ?? project.cameras[0];
    if (!object || !camera) return [];
    const start = [...camera.transform.position] as Vec3;
    const target = [...camera.target] as Vec3;
    const duration = animation.durationSec;

    if (animation.camera === "orbit") {
      const offsetX = start[0] - target[0];
      const offsetZ = start[2] - target[2];
      const radius = Math.max(1, Math.hypot(offsetX, offsetZ));
      const startAngle = Math.atan2(offsetZ, offsetX);
      const segments = 12;
      const sweep = Math.PI * 0.55;
      const waypoints: DirectorTrajectoryWaypoint[] = Array.from({ length: segments + 1 }, (_, index) => {
        const progress = index / segments;
        const angle = startAngle + sweep * progress;
        return {
          timeSec: Number((duration * progress).toFixed(3)),
          position: [
            target[0] + Math.cos(angle) * radius,
            start[1],
            target[2] + Math.sin(angle) * radius,
          ] as Vec3,
          target,
          fov: camera.fov,
          interpolation: "smooth" as const,
        };
      });
      project.timeline!.tracks.push(createTrajectoryTrack({
        object,
        camera,
        durationSec: duration,
        preset: "custom",
        waypoints,
        orientToPath: false,
        motion: "none",
        source: "preset",
        color: "#a9d8ff",
      }));
      return waypoints;
    }

    const deltaX = target[0] - start[0];
    const deltaZ = target[2] - start[2];
    const distance = Math.hypot(deltaX, deltaZ) || 1;
    const travel = Math.min(2.4, Math.max(0.8, distance * 0.22));
    const waypoints: DirectorTrajectoryWaypoint[] = [
      {
        timeSec: 0,
        position: start,
        target,
        fov: camera.fov,
        interpolation: "smooth",
      },
      {
        timeSec: duration,
        position: [
          start[0] + (deltaX / distance) * travel,
          start[1],
          start[2] + (deltaZ / distance) * travel,
        ] as Vec3,
        target,
        fov: camera.fov,
        interpolation: "smooth",
      },
    ];
    project.timeline!.tracks.push(createTrajectoryTrack({
      object,
      camera,
      durationSec: duration,
      preset: "custom",
      waypoints,
      orientToPath: false,
      motion: "none",
      source: "preset",
      color: "#a9d8ff",
    }));
    return waypoints;
  }

  /** 角色轨道：沿指定轴走 / 跑，带动画时间轴里的骨骼动作 */
  function buildCharacterTracks() {
    if (animation.characterMotion === "none" || animation.characterCount <= 0) return;
    const duration = animation.durationSec;
    characterObjectIds.slice(0, animation.characterCount).forEach((objectId, index) => {
      const object = project.objects.find((item) => item.id === objectId);
      if (!object) return;
      const start = [...object.transform.position] as Vec3;
      const direction = index % 2 === 0 ? 1 : -1;
      const travel = animation.characterMotion === "run" ? 3.2 : 1.5;
      const end: Vec3 = animation.characterAxis === "z"
        ? [start[0], start[1], start[2] + travel * direction]
        : [start[0] + travel * direction, start[1], start[2]];
      const delay = Math.min(duration * 0.35, index * 0.25);
      const waypoints: DirectorTrajectoryWaypoint[] = [
        { timeSec: 0, position: start, interpolation: "smooth" },
        { timeSec: Number(delay.toFixed(3)), position: start, interpolation: "smooth" },
        { timeSec: duration, position: end, interpolation: "smooth" },
      ];
      project.timeline!.tracks.push(createTrajectoryTrack({
        object,
        durationSec: duration,
        preset: "custom",
        waypoints,
        motion: animation.characterMotion,
        orientToPath: true,
        source: "preset",
        color: object.color,
      }));
    });
  }

  /** 收口：生成演示时间轴并返回可编辑工程（每次都是全新对象，模板常量不被修改） */
  function finalize(): DirectorProject {
    project.timeline = {
      ...createDefaultDirectorTimeline(),
      durationSec: animation.durationSec,
      tracks: [],
    };
    if (animation.camera !== "none") buildCameraTrack();
    buildCharacterTracks();
    return project;
  }

  return { project, addLibraryObject, addPrimitive, addCharacter, addCamera, finalize };
}

function buildBedroom(): DirectorProject {
  const { addLibraryObject, addCharacter, addCamera, finalize } = createProjectBuilder(
    { backgroundColor: "#191b20", groundOpacity: 0.25 },
    { durationSec: 10, camera: "orbit", characterMotion: "walk", characterCount: 2 },
  );

  addLibraryObject({
    categoryId: "director-desk",
    fileName: "structure-wall.glb",
    name: "卧室背景墙",
    kind: "scene",
    position: [0, 0, -3.2],
    scale: 2,
  });
  addLibraryObject({
    categoryId: "director-desk",
    fileName: "structure-window.glb",
    name: "卧室窗",
    kind: "scene",
    position: [0.4, 1.55, -3.1],
  });
  addLibraryObject({
    categoryId: "director-desk",
    fileName: "furniture-bed-double.glb",
    name: "双人床",
    position: [-1.5, 0, -1.9],
    rotationY: Math.PI,
  });
  addLibraryObject({
    categoryId: "director-desk",
    fileName: "furniture-nightstand.glb",
    name: "床头柜",
    position: [0.15, 0, -2.6],
    rotationY: Math.PI,
  });
  addLibraryObject({
    categoryId: "director-desk",
    fileName: "furniture-wardrobe.glb",
    name: "衣柜",
    position: [2.6, 0, -2.2],
    rotationY: -Math.PI / 2,
  });
  addLibraryObject({
    categoryId: "director-desk",
    fileName: "furniture-desk.glb",
    name: "书桌",
    position: [2.4, 0, 1.4],
    rotationY: -Math.PI / 2,
  });
  addLibraryObject({
    categoryId: "director-desk",
    fileName: "furniture-chair.glb",
    name: "书桌椅",
    position: [1.6, 0, 1.4],
    rotationY: Math.PI / 2,
  });
  addLibraryObject({
    categoryId: "director-desk",
    fileName: "furniture-sofa.glb",
    name: "沙发",
    position: [-0.6, 0, 2.4],
    rotationY: Math.PI,
  });

  addCharacter({ name: "角色 A · 床边", position: [-1.8, 0, -0.4], rotationY: 0.3, pose: "phone" });
  addCharacter({ name: "角色 B · 窗前", position: [0.6, 0, -0.6], rotationY: Math.PI, pose: "stand" });
  addCharacter({ name: "角色 C · 书桌", position: [1.2, 0, 0.6], rotationY: -Math.PI / 2, pose: "sit" });
  addCharacter({ name: "角色 D · 沙发", position: [-0.9, 0, 1.5], rotationY: Math.PI, pose: "cross-arms" });

  addCamera({ name: "A · 全景机位", view: [6.4, 3.4, 6.8], target: [0, 1.1, 0], fov: 38 });
  addCamera({ name: "B · 床边近景", view: [2.8, 1.7, 2.6], target: [-1.4, 1.2, -1.6], fov: 45 });
  return finalize();
}

function buildRoom(): DirectorProject {
  const { addLibraryObject, addCamera, finalize } = createProjectBuilder(
    { backgroundColor: "#1d2026", groundOpacity: 0.2 },
    { durationSec: 8, camera: "push-in" },
  );

  // 8 × 6 米房间：后墙 + 两侧墙，墙素材真实长度 4m，这里拉长到 8m
  addLibraryObject({
    categoryId: "director-desk",
    fileName: "structure-wall.glb",
    name: "后墙",
    kind: "scene",
    position: [0, 0, -3],
    scale: 2,
  });
  addLibraryObject({
    categoryId: "director-desk",
    fileName: "structure-wall.glb",
    name: "左墙",
    kind: "scene",
    position: [-4, 0, 0],
    rotationY: Math.PI / 2,
    scale: 1.5,
  });
  addLibraryObject({
    categoryId: "director-desk",
    fileName: "structure-wall.glb",
    name: "右墙",
    kind: "scene",
    position: [4, 0, 0],
    rotationY: -Math.PI / 2,
    scale: 1.5,
  });
  addLibraryObject({
    categoryId: "director-desk",
    fileName: "structure-door.glb",
    name: "房门",
    kind: "scene",
    position: [0.8, 0, -2.9],
  });
  addLibraryObject({
    categoryId: "director-desk",
    fileName: "structure-window.glb",
    name: "左窗",
    kind: "scene",
    position: [-3.95, 1.5, 0],
    rotationY: Math.PI / 2,
  });
  addLibraryObject({
    categoryId: "director-desk",
    fileName: "structure-window.glb",
    name: "右窗",
    kind: "scene",
    position: [3.95, 1.5, 1.6],
    rotationY: -Math.PI / 2,
  });

  addCamera({ name: "A · 房间全景", view: [3.2, 1.75, 2.8], target: [0, 1.2, 0], fov: 50 });
  return finalize();
}

function buildPark(): DirectorProject {
  const { addLibraryObject, addCharacter, addCamera, finalize } = createProjectBuilder(
    { backgroundColor: "#101820", groundOpacity: 0.55 },
    { durationSec: 10, camera: "orbit", characterMotion: "walk", characterCount: 2 },
  );

  const trees: Array<[Vec3, number, string]> = [
    [[-7, 0, -5], 1, "plant-broadleaf.glb"],
    [[-3, 0, -7], 0.85, "plant-conifer.glb"],
    [[4, 0, -6], 1.1, "plant-broadleaf.glb"],
    [[8, 0, -2], 0.9, "plant-conifer.glb"],
    [[-7, 0, 4], 0.8, "plant-broadleaf.glb"],
    [[5, 0, 5], 1, "plant-conifer.glb"],
  ];
  trees.forEach(([position, scale, fileName], index) => {
    addLibraryObject({
      categoryId: "director-desk",
      fileName,
      name: `树木 ${index + 1}`,
      kind: "scene",
      position,
      rotationY: index * 0.6,
      scale,
    });
  });
  addLibraryObject({
    categoryId: "director-desk",
    fileName: "furniture-bench.glb",
    name: "林间长椅",
    position: [0, 0, -3],
  });
  addLibraryObject({
    categoryId: "director-desk",
    fileName: "terrain-rock.glb",
    name: "岩石 A",
    kind: "scene",
    position: [-4, 0, 0],
    scale: 1.4,
  });
  addLibraryObject({
    categoryId: "director-desk",
    fileName: "terrain-rock.glb",
    name: "岩石 B",
    kind: "scene",
    position: [5, 0, 2],
    rotationY: 1.1,
  });
  addLibraryObject({
    categoryId: "director-desk",
    fileName: "plant-bush.glb",
    name: "灌木 A",
    kind: "scene",
    position: [-2.2, 0, 2.6],
  });
  addLibraryObject({
    categoryId: "director-desk",
    fileName: "plant-bush.glb",
    name: "灌木 B",
    kind: "scene",
    position: [3.2, 0, -3.6],
    rotationY: 0.8,
  });

  addCharacter({ name: "角色 A", position: [-0.7, 0, 0.2], rotationY: Math.PI, pose: "lean" });
  addCharacter({ name: "角色 B", position: [0.8, 0, 0.4], rotationY: Math.PI, pose: "stand" });

  addCamera({ name: "A · 林间全景", view: [7, 3.2, 8], target: [0, 1, 0], fov: 36 });
  return finalize();
}

function buildStreet(): DirectorProject {
  const { addLibraryObject, addCharacter, addCamera, finalize } = createProjectBuilder(
    { backgroundColor: "#121826", groundOpacity: 0.45 },
    { durationSec: 10, camera: "push-in", characterMotion: "walk", characterCount: 2, characterAxis: "z" },
  );

  // 道路：直路素材真实长度 10m，沿中轴铺两段
  addLibraryObject({
    categoryId: "director-desk",
    fileName: "road-straight.glb",
    name: "道路 · 近段",
    kind: "scene",
    position: [0, 0.01, 3],
  });
  addLibraryObject({
    categoryId: "director-desk",
    fileName: "road-straight.glb",
    name: "道路 · 远段",
    kind: "scene",
    position: [0, 0.01, -7],
  });

  const buildings: Array<[Vec3, number, string, string]> = [
    [[-7, 0, -5], Math.PI / 2, "building-shop.glb", "西侧商铺"],
    [[-7, 0, 3], Math.PI / 2, "building-house.glb", "西侧住宅"],
    [[7, 0, -6], -Math.PI / 2, "building-house.glb", "东侧住宅"],
    [[7, 0, 3], -Math.PI / 2, "building-shop.glb", "东侧商铺"],
  ];
  buildings.forEach(([position, rotationY, fileName, name]) => {
    addLibraryObject({
      categoryId: "director-desk",
      fileName,
      name,
      kind: "scene",
      position,
      rotationY,
      scale: 0.9,
    });
  });

  addLibraryObject({
    categoryId: "outdoor",
    fileName: "street_light.obj",
    name: "西侧路灯 1",
    kind: "scene",
    position: [-3.5, 0, 2],
  });
  addLibraryObject({
    categoryId: "outdoor",
    fileName: "street_light.obj",
    name: "西侧路灯 2",
    kind: "scene",
    position: [-3.5, 0, -6],
  });
  addLibraryObject({
    categoryId: "director-desk",
    fileName: "road-busstop.glb",
    name: "公交站亭",
    kind: "scene",
    position: [4.2, 0, -1],
    rotationY: -Math.PI / 2,
  });
  addLibraryObject({
    categoryId: "director-desk",
    fileName: "vehicle-sedan.glb",
    name: "路边轿车",
    position: [2.4, 0.01, -2],
    rotationY: Math.PI,
  });
  addLibraryObject({
    categoryId: "director-desk",
    fileName: "vehicle-bus.glb",
    name: "公交车",
    position: [-2.4, 0.01, 5],
  });
  addLibraryObject({
    categoryId: "director-desk",
    fileName: "industrial-cone.glb",
    name: "路锥",
    position: [3.2, 0, 1.4],
  });

  addCharacter({ name: "角色 A · 行人", position: [-0.8, 0, 1.8], rotationY: Math.PI, pose: "walk" });
  addCharacter({ name: "角色 B · 行人", position: [0.9, 0, 1.2], rotationY: Math.PI, pose: "stand" });

  addCamera({ name: "A · 街口机位", view: [0, 1.75, 11], target: [0, 1.3, -3], fov: 40 });
  addCamera({ name: "B · 人行道机位", view: [3.4, 1.7, 4.4], target: [-0.6, 1.2, -1.2], fov: 45 });
  return finalize();
}

function buildCourtyard(): DirectorProject {
  const { addLibraryObject, addCharacter, addCamera, finalize } = createProjectBuilder(
    { backgroundColor: "#171b1d", groundOpacity: 0.5 },
    { durationSec: 10, camera: "orbit", characterMotion: "walk", characterCount: 2 },
  );

  addLibraryObject({
    categoryId: "director-desk",
    fileName: "building-pavilion.glb",
    name: "庭院亭子",
    kind: "scene",
    position: [0, 0, -6],
  });
  addLibraryObject({
    categoryId: "director-desk",
    fileName: "structure-wall.glb",
    name: "北围墙",
    kind: "scene",
    position: [-4.6, 0, -3.4],
    rotationY: Math.PI / 2,
    scale: 1.4,
  });
  addLibraryObject({
    categoryId: "director-desk",
    fileName: "structure-wall.glb",
    name: "东围墙",
    kind: "scene",
    position: [4.6, 0, -3.4],
    rotationY: Math.PI / 2,
    scale: 1.4,
  });
  addLibraryObject({
    categoryId: "director-desk",
    fileName: "structure-railing.glb",
    name: "入口栏杆",
    kind: "scene",
    position: [3.6, 0, 5.6],
  });
  addLibraryObject({
    categoryId: "director-desk",
    fileName: "theme-table.glb",
    name: "庭院长案",
    position: [0, 0, -1.2],
  });
  addLibraryObject({
    categoryId: "director-desk",
    fileName: "furniture-chair.glb",
    name: "长案座椅 A",
    position: [-0.9, 0, -0.1],
    rotationY: Math.PI,
  });
  addLibraryObject({
    categoryId: "director-desk",
    fileName: "furniture-chair.glb",
    name: "长案座椅 B",
    position: [0.9, 0, -0.1],
    rotationY: Math.PI,
  });
  addLibraryObject({
    categoryId: "director-desk",
    fileName: "plant-broadleaf.glb",
    name: "庭院树",
    kind: "scene",
    position: [-4.2, 0, -2.4],
    scale: 0.85,
  });
  addLibraryObject({
    categoryId: "director-desk",
    fileName: "plant-bush.glb",
    name: "庭院灌木",
    kind: "scene",
    position: [3.8, 0, -4.6],
  });

  addCharacter({ name: "角色 A", position: [-1.4, 0, 1.4], rotationY: Math.PI, pose: "wave" });
  addCharacter({ name: "角色 B", position: [1.2, 0, 1.8], rotationY: Math.PI, pose: "stand" });

  addCamera({ name: "A · 庭院全景", view: [0, 2.1, 8], target: [0, 1.2, -2], fov: 40 });
  return finalize();
}

function buildLightStage(): DirectorProject {
  const { addLibraryObject, addPrimitive, addCharacter, addCamera, finalize } = createProjectBuilder(
    { backgroundColor: "#151d2b", groundOpacity: 0.3 },
    { durationSec: 8, camera: "orbit", characterMotion: "walk", characterCount: 1 },
  );

  addPrimitive({
    name: "圆形台座",
    geometryType: "cylinder",
    position: [0, 0.1, 0],
    scale: [3.2, 0.2, 3.2],
    color: "#737b8a",
  });
  addPrimitive({
    name: "背景环",
    geometryType: "torus",
    position: [0, 2.2, -3.2],
    rotationY: Math.PI / 2,
    scale: 1.8,
    color: "#91bbff",
  });
  addLibraryObject({
    categoryId: "director-desk",
    fileName: "structure-wall.glb",
    name: "后景墙",
    kind: "scene",
    position: [0, 0, -4.6],
    scale: 3,
  });
  addLibraryObject({
    categoryId: "director-desk",
    fileName: "structure-column.glb",
    name: "左侧立柱",
    kind: "scene",
    position: [-4.4, 0, -1],
  });
  addLibraryObject({
    categoryId: "director-desk",
    fileName: "structure-column.glb",
    name: "右侧立柱",
    kind: "scene",
    position: [4.4, 0, -1],
  });

  addCharacter({ name: "角色 A · 舞台中心", position: [0, 0.2, 0], rotationY: 0, pose: "stand" });
  addCharacter({ name: "角色 B · 侧台", position: [2.2, 0, -1.4], rotationY: -0.8, pose: "cross-arms" });

  addCamera({ name: "A · 环绕机位", view: [3.5, 2.4, 6.2], target: [0, 1.1, 0], fov: 32 });
  addCamera({ name: "B · 正面机位", view: [0, 1.7, 6.4], target: [0, 1.35, 0], fov: 35 });
  return finalize();
}

function buildDollyHall(): DirectorProject {
  const { addLibraryObject, addCharacter, addCamera, finalize } = createProjectBuilder(
    { backgroundColor: "#0f1218", groundOpacity: 0.25 },
    { durationSec: 8, camera: "push-in", characterMotion: "walk", characterCount: 1, characterAxis: "z" },
  );

  // 长廊：两侧墙体 + 立柱形成纵深
  addLibraryObject({
    categoryId: "director-desk",
    fileName: "structure-wall.glb",
    name: "左侧长廊墙",
    kind: "scene",
    position: [-2.4, 0, -2],
    rotationY: Math.PI / 2,
    scale: 1.6,
  });
  addLibraryObject({
    categoryId: "director-desk",
    fileName: "structure-wall.glb",
    name: "右侧长廊墙",
    kind: "scene",
    position: [2.4, 0, -2],
    rotationY: -Math.PI / 2,
    scale: 1.6,
  });
  addLibraryObject({
    categoryId: "director-desk",
    fileName: "structure-wall.glb",
    name: "尽头墙",
    kind: "scene",
    position: [0, 0, -6.4],
    scale: 1.4,
  });
  [-4, -1.4, 1.2].forEach((z, index) => {
    addLibraryObject({
      categoryId: "director-desk",
      fileName: "structure-column.glb",
      name: `左侧立柱 ${index + 1}`,
      kind: "scene",
      position: [-2.2, 0, z],
    });
    addLibraryObject({
      categoryId: "director-desk",
      fileName: "structure-column.glb",
      name: `右侧立柱 ${index + 1}`,
      kind: "scene",
      position: [2.2, 0, z],
    });
  });

  addCharacter({ name: "角色 A · 长廊", position: [0, 0, -1.4], rotationY: Math.PI, pose: "walk" });
  addCamera({ name: "A · 纵深机位", view: [0, 1.6, 4.6], target: [0, 1.25, -2.4], fov: 38 });
  return finalize();
}

function buildNeonChase(): DirectorProject {
  const { addLibraryObject, addCharacter, addCamera, finalize } = createProjectBuilder(
    { backgroundColor: "#0b1020", groundOpacity: 0.4 },
    { durationSec: 6, camera: "push-in", characterMotion: "run", characterCount: 2, characterAxis: "z" },
  );

  addLibraryObject({
    categoryId: "director-desk",
    fileName: "road-straight.glb",
    name: "夜街道路",
    kind: "scene",
    position: [0, 0.01, 0],
  });
  addLibraryObject({
    categoryId: "director-desk",
    fileName: "building-shop.glb",
    name: "西侧商铺",
    kind: "scene",
    position: [-6.4, 0, -3],
    rotationY: Math.PI / 2,
  });
  addLibraryObject({
    categoryId: "director-desk",
    fileName: "building-shop.glb",
    name: "东侧商铺",
    kind: "scene",
    position: [6.4, 0, 2],
    rotationY: -Math.PI / 2,
  });
  addLibraryObject({
    categoryId: "outdoor",
    fileName: "street_light.obj",
    name: "路灯 A",
    kind: "scene",
    position: [-3.4, 0, 3],
  });
  addLibraryObject({
    categoryId: "outdoor",
    fileName: "street_light.obj",
    name: "路灯 B",
    kind: "scene",
    position: [3.4, 0, -4],
  });
  addLibraryObject({
    categoryId: "director-desk",
    fileName: "vehicle-sedan.glb",
    name: "路边车辆",
    position: [-2.4, 0.01, -1],
    rotationY: Math.PI,
  });
  addLibraryObject({
    categoryId: "director-desk",
    fileName: "industrial-cone.glb",
    name: "路锥 A",
    position: [1.8, 0, 1.6],
  });
  addLibraryObject({
    categoryId: "director-desk",
    fileName: "industrial-cone.glb",
    name: "路锥 B",
    position: [2.4, 0, -2.2],
  });

  addCharacter({ name: "角色 A · 追逐", position: [-0.8, 0, 1.2], rotationY: Math.PI, pose: "run" });
  addCharacter({ name: "角色 B · 追逐", position: [0.9, 0, -0.6], rotationY: Math.PI, pose: "run" });

  addCamera({ name: "A · 低机位追逐", view: [0.6, 0.9, 6.4], target: [0, 1.2, -2], fov: 52 });
  return finalize();
}

function buildAbstractStage(): DirectorProject {
  const { addPrimitive, addCamera, finalize } = createProjectBuilder(
    { backgroundColor: "#08090d", showGround: false },
    { durationSec: 8, camera: "orbit" },
  );

  addPrimitive({
    name: "主环体",
    geometryType: "torus",
    position: [0, 1.6, 0],
    rotationY: Math.PI / 2,
    scale: 2.2,
    color: "#5b8cff",
  });
  addPrimitive({
    name: "中心球体",
    geometryType: "sphere",
    position: [0, 1.6, 0],
    scale: 0.9,
    color: "#e8f0ff",
  });
  addPrimitive({
    name: "左侧立柱",
    geometryType: "cylinder",
    position: [-3.2, 1.4, -1.2],
    scale: [0.35, 2.8, 0.35],
    color: "#3f4d6b",
  });
  addPrimitive({
    name: "右侧棱锥",
    geometryType: "pyramid",
    position: [3.1, 1.1, -0.6],
    rotationY: 0.6,
    scale: 1.4,
    color: "#8b5cf6",
  });
  addPrimitive({
    name: "前景圆环",
    geometryType: "torus",
    position: [1.4, 0.9, 2.4],
    rotationY: 0.4,
    scale: 1,
    color: "#22d3ee",
  });

  addCamera({ name: "A · 抽象全景", view: [6.2, 3.6, 8.2], target: [0, 1.5, 0], fov: 40 });
  return finalize();
}

function buildBlank(): DirectorProject {
  const { addCamera, finalize } = createProjectBuilder();
  addCamera({ name: "A · 主机位", view: [5, 3, 7], target: [0, 1, 0], fov: 40 });
  return finalize();
}

/**
 * 参考 director-desk 的预置场景模板，按当前编辑器的对象 / 素材格式重新编排。
 * 套用后得到的是普通可编辑工程：对象、材质、机位都能继续改。
 */
export const DIRECTOR_TEMPLATES: DirectorTemplate[] = [
  {
    id: "bedroom",
    name: "卧室 · 四人调度",
    category: "室内",
    detail: "双人床、衣柜与书桌，四位角色站位，窗墙作背景",
    build: buildBedroom,
  },
  {
    id: "room",
    name: "空房间",
    category: "室内",
    detail: "8 × 6 米空房间，墙 / 门 / 窗齐全，留给角色与道具",
    build: buildRoom,
  },
  {
    id: "park",
    name: "林地空地",
    category: "室外",
    detail: "林间空地：阔叶树、岩石与长椅，双人调度",
    build: buildPark,
  },
  {
    id: "street",
    name: "街道",
    category: "室外",
    detail: "街道两侧商铺与住宅、车辆与路灯，适合对话戏",
    build: buildStreet,
  },
  {
    id: "courtyard",
    name: "庭院",
    category: "室外",
    detail: "亭子、围墙与庭院长案，适合古风或生活场景",
    build: buildCourtyard,
  },
  {
    id: "light-stage",
    name: "光影舞台",
    category: "特色",
    detail: "圆形台座与背景板，双人物与两台机位",
    build: buildLightStage,
  },
  {
    id: "dolly-hall",
    name: "悬疑长廊",
    category: "特色",
    detail: "长廊立柱与纵深机位，适合悬疑氛围",
    build: buildDollyHall,
  },
  {
    id: "neon-chase",
    name: "夜街追逐",
    category: "特色",
    detail: "夜街、奔跑人物与车辆，适合追逐戏",
    build: buildNeonChase,
  },
  {
    id: "abstract-stage",
    name: "流光空间",
    category: "抽象",
    detail: "深色空间里的几何体构成，适合抽象视觉",
    build: buildAbstractStage,
  },
  {
    id: "blank",
    name: "空白场地",
    category: "自由搭建",
    detail: "只有机位与地面，从零开始搭建",
    build: buildBlank,
  },
];

export function getDirectorTemplate(id: string) {
  return DIRECTOR_TEMPLATES.find((template) => template.id === id) ?? null;
}
