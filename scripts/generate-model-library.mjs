/**
 * 生成导演台「模型库」的预置白模。
 *
 * 输出：
 *   src/editor/modelLibrary/presets/<分类>/<文件名>.obj
 *   src/editor/modelLibrary/presets/<分类>/<文件名>.svg   （等轴测缩略图）
 *   src/editor/modelLibrary/presets/manifest.json        （名称 / 分类 / 真实尺寸）
 *
 * 模型都是低模白模，用来做走位与机位预演；尺寸按米制，导入后会按真实大小摆放。
 */
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const outRoot = join(root, 'src', 'editor', 'modelLibrary', 'presets')

// ---------- 几何 ----------

function rotate([x, y, z], [rx, ry, rz]) {
  const cx = Math.cos(rx), sx = Math.sin(rx)
  const y1 = y * cx - z * sx
  const z1 = y * sx + z * cx
  const cy = Math.cos(ry), sy = Math.sin(ry)
  const x2 = x * cy + z1 * sy
  const z2 = -x * sy + z1 * cy
  const cz = Math.cos(rz), sz = Math.sin(rz)
  return [x2 * cz - y1 * sz, x2 * sz + y1 * cz, z2]
}

function apply(verts, opts = {}) {
  const { x = 0, y = 0, z = 0, rx = 0, ry = 0, rz = 0 } = opts
  return verts.map((v) => {
    const [a, b, c] = rotate(v, [rx, ry, rz])
    return [a + x, b + y, c + z]
  })
}

function box(w, h, d, opts = {}) {
  const hw = w / 2, hh = h / 2, hd = d / 2
  const verts = apply([
    [-hw, -hh, -hd], [hw, -hh, -hd], [hw, hh, -hd], [-hw, hh, -hd],
    [-hw, -hh, hd], [hw, -hh, hd], [hw, hh, hd], [-hw, hh, hd],
  ], opts)
  const faces = [
    [4, 5, 6, 7], [1, 0, 3, 2], [0, 4, 7, 3],
    [5, 1, 2, 6], [0, 1, 5, 4], [3, 7, 6, 2],
  ]
  return { verts, faces }
}

function cylinder(rBottom, rTop, h, opts = {}, seg = 12) {
  const verts = []
  const faces = []
  const yb = -h / 2, yt = h / 2
  for (let i = 0; i < seg; i += 1) {
    const t = (i / seg) * Math.PI * 2
    verts.push([Math.cos(t) * rBottom, yb, Math.sin(t) * rBottom])
  }
  for (let i = 0; i < seg; i += 1) {
    const t = (i / seg) * Math.PI * 2
    verts.push([Math.cos(t) * rTop, yt, Math.sin(t) * rTop])
  }
  for (let i = 0; i < seg; i += 1) {
    const j = (i + 1) % seg
    faces.push([i, seg + i, seg + j, j])
  }
  // 底盖（-Y）用递增顺序；顶盖（+Y）反向
  faces.push([...Array(seg).keys()])
  faces.push([...Array(seg).keys()].reverse().map((i) => i + seg))
  return { verts: apply(verts, opts), faces }
}

function sphere(r, opts = {}, seg = 10, rings = 6, sy = 1) {
  const verts = []
  const faces = []
  const ringsY = []
  for (let i = 0; i <= rings; i += 1) {
    const phi = (i / rings) * Math.PI
    ringsY.push(Math.cos(phi) * r * sy)
  }
  const ringStarts = []
  for (let i = 1; i < rings; i += 1) {
    const phi = (i / rings) * Math.PI
    const ry = Math.cos(phi) * r * sy
    const rr = Math.sin(phi) * r
    ringStarts.push(verts.length)
    for (let j = 0; j < seg; j += 1) {
      const t = (j / seg) * Math.PI * 2
      verts.push([Math.cos(t) * rr, ry, Math.sin(t) * rr])
    }
  }
  for (let i = 0; i < ringStarts.length - 1; i += 1) {
    const a = ringStarts[i], b = ringStarts[i + 1]
    for (let j = 0; j < seg; j += 1) {
      const jn = (j + 1) % seg
      faces.push([a + j, b + j, b + jn, a + jn])
    }
  }
  const top = verts.length
  verts.push([0, ringsY[0], 0])
  const bottom = verts.length
  verts.push([0, ringsY[rings], 0])
  const first = ringStarts[0], last = ringStarts[ringStarts.length - 1]
  for (let j = 0; j < seg; j += 1) {
    const jn = (j + 1) % seg
    faces.push([top, first + jn, first + j])
    faces.push([bottom, last + j, last + jn])
  }
  return { verts: apply(verts, opts), faces }
}

function prism(w, h, d, opts = {}) {
  const hw = w / 2, hd = d / 2
  const verts = apply([
    [-hw, 0, hd], [hw, 0, hd], [0, h, hd],
    [-hw, 0, -hd], [hw, 0, -hd], [0, h, -hd],
  ], opts)
  const faces = [
    [0, 1, 2], [3, 5, 4],
    [0, 2, 5, 3], [1, 4, 5, 2], [0, 3, 4, 1],
  ]
  return { verts, faces }
}

function merge(parts) {
  const verts = []
  const faces = []
  for (const part of parts) {
    const offset = verts.length
    verts.push(...part.verts)
    faces.push(...part.faces.map((f) => f.map((i) => i + offset)))
  }
  return { verts, faces }
}

// ---------- 造型 ----------

const models = []
function add(category, fileName, name, parts) {
  models.push({ category, fileName, name, geometry: merge(parts) })
}

// 便利生活
add('便利生活', 'soda_bottle', '饮料瓶', [
  cylinder(0.05, 0.05, 0.2, { y: 0.1 }, 12),
  cylinder(0.022, 0.05, 0.08, { y: 0.24 }, 12),
  cylinder(0.025, 0.025, 0.03, { y: 0.295 }, 10),
])
add('便利生活', 'soda_can', '易拉罐', [
  cylinder(0.033, 0.033, 0.12, { y: 0.06 }, 14),
  cylinder(0.028, 0.033, 0.008, { y: 0.124 }, 14),
])
add('便利生活', 'shopping_basket', '购物篮', [
  box(0.4, 0.02, 0.28, { y: 0.01 }),
  box(0.4, 0.16, 0.02, { y: 0.09, z: -0.13 }),
  box(0.4, 0.16, 0.02, { y: 0.09, z: 0.13 }),
  box(0.02, 0.16, 0.28, { x: -0.19, y: 0.09 }),
  box(0.02, 0.16, 0.28, { x: 0.19, y: 0.09 }),
  box(0.03, 0.02, 0.3, { y: 0.2 }),
  box(0.03, 0.06, 0.03, { x: -0.16, y: 0.19, z: -0.11 }),
  box(0.03, 0.06, 0.03, { x: 0.16, y: 0.19, z: -0.11 }),
  box(0.03, 0.06, 0.03, { x: -0.16, y: 0.19, z: 0.11 }),
  box(0.03, 0.06, 0.03, { x: 0.16, y: 0.19, z: 0.11 }),
])
add('便利生活', 'shelf', '货架', [
  box(0.9, 0.04, 0.35, { y: 0.02 }),
  box(0.9, 0.04, 0.35, { y: 0.5 }),
  box(0.9, 0.04, 0.35, { y: 0.98 }),
  box(0.9, 0.04, 0.35, { y: 1.46 }),
  box(0.04, 1.5, 0.35, { x: -0.43, y: 0.75 }),
  box(0.04, 1.5, 0.35, { x: 0.43, y: 0.75 }),
  box(0.9, 1.5, 0.02, { y: 0.75, z: -0.165 }),
])
add('便利生活', 'vending_machine', '自动售货机', [
  box(0.8, 1.8, 0.6, { y: 0.9 }),
  box(0.62, 1.0, 0.03, { y: 1.22, z: 0.31 }),
  box(0.5, 0.16, 0.03, { y: 0.48, z: 0.31 }),
  box(0.12, 0.3, 0.05, { x: 0.26, y: 0.72, z: 0.31 }),
])
add('便利生活', 'shopping_cart', '购物车', [
  box(0.5, 0.28, 0.34, { y: 0.52 }),
  box(0.5, 0.02, 0.34, { y: 0.38 }),
  box(0.03, 0.38, 0.03, { x: -0.24, y: 0.2, z: -0.15 }),
  box(0.03, 0.38, 0.03, { x: 0.24, y: 0.2, z: -0.15 }),
  box(0.03, 0.38, 0.03, { x: -0.24, y: 0.2, z: 0.15 }),
  box(0.03, 0.38, 0.03, { x: 0.24, y: 0.2, z: 0.15 }),
  cylinder(0.06, 0.06, 0.03, { x: -0.24, y: 0.06, z: -0.15, rz: Math.PI / 2 }, 10),
  cylinder(0.06, 0.06, 0.03, { x: 0.24, y: 0.06, z: -0.15, rz: Math.PI / 2 }, 10),
  cylinder(0.06, 0.06, 0.03, { x: -0.24, y: 0.06, z: 0.15, rz: Math.PI / 2 }, 10),
  cylinder(0.06, 0.06, 0.03, { x: 0.24, y: 0.06, z: 0.15, rz: Math.PI / 2 }, 10),
  box(0.04, 0.32, 0.04, { x: 0.26, y: 0.72, z: 0.16 }),
  box(0.04, 0.04, 0.3, { x: 0.26, y: 0.86, z: 0.02 }),
])
add('便利生活', 'trash_can', '垃圾桶', [
  cylinder(0.22, 0.2, 0.62, { y: 0.31 }, 14),
  cylinder(0.23, 0.23, 0.04, { y: 0.64 }, 14),
  box(0.16, 0.03, 0.04, { y: 0.68 }),
])
add('便利生活', 'cardboard_box', '纸箱', [
  box(0.42, 0.3, 0.32, { y: 0.15 }),
  box(0.43, 0.02, 0.33, { y: 0.31 }),
  box(0.08, 0.005, 0.34, { y: 0.32 }),
])

// 生活家居
add('生活家居', 'chair', '椅子', [
  box(0.44, 0.06, 0.44, { y: 0.44 }),
  box(0.04, 0.44, 0.04, { x: -0.19, y: 0.22, z: -0.19 }),
  box(0.04, 0.44, 0.04, { x: 0.19, y: 0.22, z: -0.19 }),
  box(0.04, 0.44, 0.04, { x: -0.19, y: 0.22, z: 0.19 }),
  box(0.04, 0.44, 0.04, { x: 0.19, y: 0.22, z: 0.19 }),
  box(0.04, 0.52, 0.04, { x: -0.19, y: 0.72, z: -0.19 }),
  box(0.04, 0.52, 0.04, { x: 0.19, y: 0.72, z: -0.19 }),
  box(0.44, 0.34, 0.04, { y: 0.78, z: -0.19 }),
])
add('生活家居', 'stool', '圆凳', [
  cylinder(0.18, 0.18, 0.05, { y: 0.45 }, 14),
  cylinder(0.03, 0.03, 0.45, { x: -0.11, y: 0.22, z: -0.06 }, 8),
  cylinder(0.03, 0.03, 0.45, { x: 0.11, y: 0.22, z: -0.06 }, 8),
  cylinder(0.03, 0.03, 0.45, { x: 0, y: 0.22, z: 0.12 }, 8),
])
add('生活家居', 'sofa', '沙发', [
  box(1.8, 0.34, 0.78, { y: 0.2 }),
  box(1.8, 0.5, 0.16, { y: 0.57, z: -0.31 }),
  box(0.16, 0.52, 0.78, { x: -0.82, y: 0.32 }),
  box(0.16, 0.52, 0.78, { x: 0.82, y: 0.32 }),
  box(0.78, 0.12, 0.62, { x: -0.39, y: 0.43, z: 0.04 }),
  box(0.78, 0.12, 0.62, { x: 0.39, y: 0.43, z: 0.04 }),
])
add('生活家居', 'coffee_table', '茶几', [
  box(1.0, 0.05, 0.6, { y: 0.4 }),
  box(0.05, 0.4, 0.05, { x: -0.44, y: 0.2, z: -0.25 }),
  box(0.05, 0.4, 0.05, { x: 0.44, y: 0.2, z: -0.25 }),
  box(0.05, 0.4, 0.05, { x: -0.44, y: 0.2, z: 0.25 }),
  box(0.05, 0.4, 0.05, { x: 0.44, y: 0.2, z: 0.25 }),
  box(0.9, 0.03, 0.5, { y: 0.16 }),
])
add('生活家居', 'dining_table', '餐桌', [
  box(1.4, 0.06, 0.8, { y: 0.74 }),
  box(0.06, 0.74, 0.06, { x: -0.62, y: 0.37, z: -0.32 }),
  box(0.06, 0.74, 0.06, { x: 0.62, y: 0.37, z: -0.32 }),
  box(0.06, 0.74, 0.06, { x: -0.62, y: 0.37, z: 0.32 }),
  box(0.06, 0.74, 0.06, { x: 0.62, y: 0.37, z: 0.32 }),
  box(1.2, 0.05, 0.1, { y: 0.68, z: -0.3 }),
  box(1.2, 0.05, 0.1, { y: 0.68, z: 0.3 }),
])
add('生活家居', 'bed', '床', [
  box(1.5, 0.28, 2.0, { y: 0.14 }),
  box(1.42, 0.2, 1.9, { y: 0.38 }),
  box(1.5, 0.6, 0.1, { y: 0.44, z: -1.0 }),
  box(0.5, 0.12, 0.3, { x: -0.36, y: 0.54, z: -0.72 }),
  box(0.5, 0.12, 0.3, { x: 0.36, y: 0.54, z: -0.72 }),
  box(1.3, 0.06, 1.1, { y: 0.51, z: 0.32 }),
])
add('生活家居', 'bookshelf', '书架', [
  box(0.9, 0.04, 0.32, { y: 0.02 }),
  box(0.9, 0.04, 0.32, { y: 0.5 }),
  box(0.9, 0.04, 0.32, { y: 0.98 }),
  box(0.9, 0.04, 0.32, { y: 1.46 }),
  box(0.9, 0.04, 0.32, { y: 1.9 }),
  box(0.04, 1.94, 0.32, { x: -0.43, y: 0.97 }),
  box(0.04, 1.94, 0.32, { x: 0.43, y: 0.97 }),
  box(0.9, 1.94, 0.02, { y: 0.97, z: -0.15 }),
])
add('生活家居', 'wardrobe', '衣柜', [
  box(1.0, 2.0, 0.6, { y: 1.0 }),
  box(0.46, 1.9, 0.03, { x: -0.24, y: 1.0, z: 0.31 }),
  box(0.46, 1.9, 0.03, { x: 0.24, y: 1.0, z: 0.31 }),
  box(0.03, 0.18, 0.03, { x: -0.02, y: 1.0, z: 0.34 }),
  box(0.03, 0.18, 0.03, { x: 0.02, y: 1.0, z: 0.34 }),
])
add('生活家居', 'floor_lamp', '落地灯', [
  cylinder(0.18, 0.18, 0.04, { y: 0.02 }, 14),
  cylinder(0.025, 0.025, 1.5, { y: 0.77 }, 8),
  cylinder(0.08, 0.24, 0.32, { y: 1.66 }, 12),
])
add('生活家居', 'tv', '电视', [
  box(1.2, 0.7, 0.06, { y: 0.95 }),
  box(0.08, 0.24, 0.08, { y: 0.48 }),
  box(0.6, 0.04, 0.36, { y: 0.36 }),
  box(0.05, 0.05, 0.05, { y: 0.4 }),
])
add('生活家居', 'fridge', '冰箱', [
  box(0.72, 1.8, 0.68, { y: 0.9 }),
  box(0.66, 0.72, 0.02, { y: 1.4, z: 0.35 }),
  box(0.66, 0.98, 0.02, { y: 0.53, z: 0.35 }),
  box(0.04, 0.3, 0.04, { x: 0.26, y: 1.42, z: 0.37 }),
  box(0.04, 0.3, 0.04, { x: 0.26, y: 0.55, z: 0.37 }),
])
add('生活家居', 'nightstand', '床头柜', [
  box(0.5, 0.55, 0.45, { y: 0.275 }),
  box(0.42, 0.18, 0.02, { y: 0.38, z: 0.23 }),
  box(0.42, 0.18, 0.02, { y: 0.16, z: 0.23 }),
  box(0.1, 0.03, 0.03, { y: 0.38, z: 0.25 }),
])

// 户外出行
add('户外出行', 'bench', '长椅', [
  box(1.4, 0.06, 0.42, { y: 0.44 }),
  box(1.4, 0.3, 0.05, { y: 0.68, z: -0.18 }),
  box(1.4, 0.05, 0.05, { y: 0.83, z: -0.18 }),
  box(0.06, 0.44, 0.06, { x: -0.6, y: 0.22, z: -0.16 }),
  box(0.06, 0.44, 0.06, { x: 0.6, y: 0.22, z: -0.16 }),
  box(0.06, 0.44, 0.06, { x: -0.6, y: 0.22, z: 0.16 }),
  box(0.06, 0.44, 0.06, { x: 0.6, y: 0.22, z: 0.16 }),
])
add('户外出行', 'street_light', '路灯', [
  cylinder(0.09, 0.09, 0.08, { y: 0.04 }, 12),
  cylinder(0.05, 0.04, 3.0, { y: 1.54 }, 10),
  box(0.7, 0.06, 0.06, { x: 0.32, y: 3.02 }),
  box(0.26, 0.1, 0.18, { x: 0.64, y: 2.98 }),
])
add('户外出行', 'fence', '围栏', [
  box(0.08, 1.0, 0.08, { x: -0.9, y: 0.5 }),
  box(0.08, 1.0, 0.08, { x: 0, y: 0.5 }),
  box(0.08, 1.0, 0.08, { x: 0.9, y: 0.5 }),
  box(1.9, 0.08, 0.04, { y: 0.72 }),
  box(1.9, 0.08, 0.04, { y: 0.34 }),
])
add('户外出行', 'tree', '树', [
  cylinder(0.16, 0.12, 1.6, { y: 0.8 }, 10),
  sphere(0.62, { y: 1.85 }, 10, 5),
  sphere(0.45, { x: 0.35, y: 1.55 }, 9, 4),
  sphere(0.4, { x: -0.38, y: 1.6 }, 9, 4),
])
add('户外出行', 'bush', '灌木', [
  sphere(0.34, { y: 0.3, sy: 0.8 }, 9, 4),
  sphere(0.26, { x: 0.28, y: 0.24, sy: 0.8 }, 8, 4),
  sphere(0.22, { x: -0.26, y: 0.2, sy: 0.8 }, 8, 4),
])
add('户外出行', 'rock', '石头', [
  sphere(0.5, { y: 0.24, sy: 0.5 }, 7, 4),
  sphere(0.28, { x: 0.32, y: 0.16, sy: 0.55 }, 6, 3),
])
add('户外出行', 'tent', '帐篷', [
  prism(1.6, 1.0, 1.8, { y: 0.02 }),
  prism(0.5, 0.5, 0.02, { y: 0.02, z: 0.9 }),
])
add('户外出行', 'traffic_cone', '路锥', [
  box(0.3, 0.03, 0.3, { y: 0.015 }),
  cylinder(0.12, 0.02, 0.45, { y: 0.255 }, 12),
])
add('户外出行', 'mailbox', '邮箱', [
  box(0.06, 0.9, 0.06, { y: 0.45 }),
  box(0.3, 0.22, 0.34, { y: 1.0 }),
  cylinder(0.15, 0.15, 0.34, { y: 1.11, rx: Math.PI / 2 }, 12),
  box(0.02, 0.18, 0.02, { x: 0.2, y: 1.02 }),
])
add('户外出行', 'fire_hydrant', '消防栓', [
  cylinder(0.12, 0.12, 0.06, { y: 0.03 }, 12),
  cylinder(0.09, 0.09, 0.5, { y: 0.31 }, 12),
  cylinder(0.11, 0.07, 0.1, { y: 0.61 }, 12),
  box(0.34, 0.08, 0.08, { y: 0.4 }),
  cylinder(0.05, 0.05, 0.08, { x: 0.17, y: 0.4, rz: Math.PI / 2 }, 10),
  cylinder(0.05, 0.05, 0.08, { x: -0.17, y: 0.4, rz: Math.PI / 2 }, 10),
])
add('户外出行', 'bicycle', '自行车', [
  cylinder(0.34, 0.34, 0.04, { x: -0.5, y: 0.34, rz: Math.PI / 2 }, 14),
  cylinder(0.34, 0.34, 0.04, { x: 0.5, y: 0.34, rz: Math.PI / 2 }, 14),
  box(0.6, 0.04, 0.04, { y: 0.5, ry: 0.15 }),
  box(0.5, 0.04, 0.04, { x: 0.1, y: 0.42, z: 0.02, ry: -0.5 }),
  box(0.42, 0.04, 0.04, { x: 0.27, y: 0.42, z: -0.04, ry: 0.55 }),
  box(0.04, 0.32, 0.04, { x: -0.18, y: 0.58, rz: 0.2 }),
  box(0.24, 0.03, 0.03, { x: -0.05, y: 0.76 }),
  box(0.04, 0.3, 0.04, { x: 0.5, y: 0.6, rz: -0.15 }),
  box(0.3, 0.03, 0.03, { x: 0.56, y: 0.76 }),
])
add('户外出行', 'wooden_crate', '木箱', [
  box(0.5, 0.4, 0.5, { y: 0.2 }),
  box(0.52, 0.04, 0.04, { y: 0.06, z: 0.24 }),
  box(0.52, 0.04, 0.04, { y: 0.34, z: 0.24 }),
  box(0.04, 0.4, 0.04, { x: -0.24, y: 0.2, z: 0.24 }),
  box(0.04, 0.4, 0.04, { x: 0.24, y: 0.2, z: 0.24 }),
])

// 工具配件
add('工具配件', 'hammer', '锤子', [
  box(0.04, 0.34, 0.04, { y: 0.17 }),
  box(0.22, 0.08, 0.08, { y: 0.36 }),
  cylinder(0.035, 0.035, 0.05, { x: 0.13, y: 0.36, rz: Math.PI / 2 }, 8),
])
add('工具配件', 'wrench', '扳手', [
  box(0.06, 0.38, 0.02, { y: 0.22 }),
  box(0.12, 0.1, 0.02, { y: 0.44 }),
  box(0.04, 0.05, 0.02, { x: 0.04, y: 0.49 }),
  box(0.1, 0.06, 0.02, { y: 0.03 }),
])
add('工具配件', 'screwdriver', '螺丝刀', [
  cylinder(0.035, 0.03, 0.16, { y: 0.08 }, 10),
  cylinder(0.012, 0.012, 0.22, { y: 0.27 }, 8),
  cylinder(0.001, 0.012, 0.05, { y: 0.405 }, 8),
])
add('工具配件', 'hand_saw', '手锯', [
  box(0.6, 0.14, 0.01, { y: 0.28, rz: -0.05 }),
  box(0.14, 0.1, 0.05, { x: 0.32, y: 0.36 }),
  box(0.08, 0.08, 0.05, { x: 0.38, y: 0.36 }),
])
add('工具配件', 'bucket', '水桶', [
  cylinder(0.16, 0.2, 0.3, { y: 0.16 }, 14),
  cylinder(0.2, 0.2, 0.03, { y: 0.32 }, 14),
  box(0.36, 0.03, 0.03, { y: 0.46 }),
  box(0.03, 0.12, 0.03, { x: -0.17, y: 0.39 }),
  box(0.03, 0.12, 0.03, { x: 0.17, y: 0.39 }),
])
add('工具配件', 'ladder', '梯子', [
  box(0.05, 1.8, 0.05, { x: -0.22, y: 0.9 }),
  box(0.05, 1.8, 0.05, { x: 0.22, y: 0.9 }),
  box(0.48, 0.04, 0.05, { y: 0.25 }),
  box(0.48, 0.04, 0.05, { y: 0.65 }),
  box(0.48, 0.04, 0.05, { y: 1.05 }),
  box(0.48, 0.04, 0.05, { y: 1.45 }),
])
add('工具配件', 'toolbox', '工具箱', [
  box(0.5, 0.24, 0.26, { y: 0.13 }),
  box(0.52, 0.03, 0.28, { y: 0.26 }),
  box(0.2, 0.03, 0.03, { y: 0.34 }),
  box(0.03, 0.08, 0.03, { x: -0.09, y: 0.3 }),
  box(0.03, 0.08, 0.03, { x: 0.09, y: 0.3 }),
])
add('工具配件', 'workbench', '工作台', [
  box(1.4, 0.06, 0.7, { y: 0.86 }),
  box(0.06, 0.86, 0.06, { x: -0.64, y: 0.43, z: -0.3 }),
  box(0.06, 0.86, 0.06, { x: 0.64, y: 0.43, z: -0.3 }),
  box(0.06, 0.86, 0.06, { x: -0.64, y: 0.43, z: 0.3 }),
  box(0.06, 0.86, 0.06, { x: 0.64, y: 0.43, z: 0.3 }),
  box(1.3, 0.04, 0.6, { y: 0.3 }),
  box(1.4, 0.3, 0.04, { y: 1.04, z: -0.33 }),
])
add('工具配件', 'tape_measure', '卷尺', [
  box(0.18, 0.18, 0.1, { y: 0.09 }),
  cylinder(0.09, 0.09, 0.11, { y: 0.09, rx: Math.PI / 2 }, 14),
  box(0.16, 0.02, 0.02, { x: 0.16, y: 0.03 }),
])

// ---------- 输出 ----------

// 只清理自己负责的四个分类；导演台预置（manifest.director-desk.json）由 director-desk 的导出脚本维护
for (const category of ['便利生活', '生活家居', '户外出行', '工具配件']) {
  rmSync(join(outRoot, category), { recursive: true, force: true })
}
mkdirSync(outRoot, { recursive: true })

function bounds(geometry) {
  const min = [Infinity, Infinity, Infinity]
  const max = [-Infinity, -Infinity, -Infinity]
  for (const [x, y, z] of geometry.verts) {
    min[0] = Math.min(min[0], x); min[1] = Math.min(min[1], y); min[2] = Math.min(min[2], z)
    max[0] = Math.max(max[0], x); max[1] = Math.max(max[1], y); max[2] = Math.max(max[2], z)
  }
  return { min, max }
}

function objText(geometry) {
  const lines = ['# generated preset white model', 'o preset']
  for (const [x, y, z] of geometry.verts) lines.push(`v ${x.toFixed(4)} ${y.toFixed(4)} ${z.toFixed(4)}`)
  for (const face of geometry.faces) lines.push(`f ${face.map((i) => i + 1).join(' ')}`)
  return `${lines.join('\n')}\n`
}

function svgText(geometry) {
  const project = ([x, y, z]) => [x - z, (x + z) * 0.5 - y]
  const points = geometry.verts.map(project)
  const xs = points.map((p) => p[0])
  const ys = points.map((p) => p[1])
  const minX = Math.min(...xs), maxX = Math.max(...xs)
  const minY = Math.min(...ys), maxY = Math.max(...ys)
  const span = Math.max(maxX - minX, maxY - minY) || 1
  const scale = 76 / span
  const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2
  // 投影结果已与 SVG 的 y 轴同向（世界坐标越高，投影 y 越小），再取反会导致缩略图上下颠倒
  const toSvg = (p) => [(p[0] - cx) * scale + 48, (p[1] - cy) * scale + 48]

  const light = [0.45, 0.82, 0.35]
  const length = Math.hypot(...light)
  const L = light.map((v) => v / length)

  const tris = []
  for (const face of geometry.faces) {
    for (let i = 1; i < face.length - 1; i += 1) {
      const ids = [face[0], face[i], face[i + 1]]
      const [a, b, c] = ids.map((id) => geometry.verts[id])
      const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]]
      const v = [c[0] - a[0], c[1] - a[1], c[2] - a[2]]
      const n = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]]
      const nl = Math.hypot(...n) || 1
      const nn = n.map((x) => x / nl)
      const shade = 0.38 + 0.62 * Math.max(0, nn[0] * L[0] + nn[1] * L[1] + nn[2] * L[2])
      const depth = a[0] + a[1] + a[2] + b[0] + b[1] + b[2] + c[0] + c[1] + c[2]
      tris.push({ ids, shade, depth })
    }
  }
  tris.sort((a, b) => a.depth - b.depth)

  const polygons = tris.map((tri) => {
    const pts = tri.ids.map((id) => toSvg(points[id]).map((n) => n.toFixed(1)).join(',')).join(' ')
    const tone = Math.round(78 + 168 * tri.shade)
    return `<polygon points="${pts}" fill="rgb(${tone},${tone},${tone})" stroke="rgb(${Math.max(40, tone - 26)},${Math.max(40, tone - 26)},${Math.max(40, tone - 26)})" stroke-width="0.5" stroke-linejoin="round"/>`
  })

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 96 96">${polygons.join('')}</svg>\n`
}

const manifest = []
for (const model of models) {
  const dir = join(outRoot, model.category)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, `${model.fileName}.obj`), objText(model.geometry))
  writeFileSync(join(dir, `${model.fileName}.svg`), svgText(model.geometry))
  const { min, max } = bounds(model.geometry)
  const size = Math.max(max[0] - min[0], max[1] - min[1], max[2] - min[2])
  manifest.push({
    category: model.category,
    fileName: `${model.fileName}.obj`,
    name: model.name,
    size: Number(size.toFixed(3)),
  })
}

manifest.sort((a, b) => a.category.localeCompare(b.category, 'zh') || a.name.localeCompare(b.name, 'zh'))
mkdirSync(outRoot, { recursive: true })
writeFileSync(join(outRoot, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`)
console.log(`generated ${models.length} preset models -> ${outRoot}`)
