import { VRMLoaderPlugin, VRMUtils, type VRM } from '@pixiv/three-vrm';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import type { PetAction } from '../../../shared/protocol';
import type { PetRendererHandle, RendererContext } from '../../types';

const EXPRESSION_MAP: Record<PetAction, string[]> = {
  idle: ['relaxed'],
  happy: ['happy'],
  think: ['relaxed'],
  alert: ['surprised'],
  sleep: ['relaxed'],
  shy: ['happy'],
  wave: ['happy'],
};

/**
 * 3D 渲染器：VRM 走表情 + 骨骼，普通 GLB 只做整体动效。
 * 由主包按需加载，避免 three.js 拖慢首屏。
 */
export async function create(context: RendererContext): Promise<PetRendererHandle> {
  const width = Math.max(1, context.container.clientWidth);
  const height = Math.max(1, context.container.clientHeight);

  const renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.setSize(width, height, false);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  const canvas = renderer.domElement;
  canvas.className = 'pet-canvas';
  context.container.appendChild(canvas);

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(32, width / height, 0.1, 30);

  scene.add(new THREE.HemisphereLight(0xffffff, 0x9dc4b8, 1.5));
  const keyLight = new THREE.DirectionalLight(0xffffff, 1.6);
  keyLight.position.set(1.4, 2.6, 2.4);
  scene.add(keyLight);
  const rimLight = new THREE.DirectionalLight(0x9be7d4, 0.8);
  rimLight.position.set(-2, 1.6, -1.6);
  scene.add(rimLight);

  const gltf = await loadGltf(context.assets.vrmModelUri!);
  const vrm = gltf.userData.vrm as VRM | undefined;

  const avatar = vrm ? vrm.scene : gltf.scene;
  if (vrm) {
    // VRM 0.x 是 -Z 朝向，转到 +Z 面向摄像机
    try {
      (VRMUtils as unknown as { rotateVRM0?: (model: VRM) => void }).rotateVRM0?.(vrm);
    } catch {
      // 非 VRM0 模型会抛错，忽略
    }
    VRMUtils.removeUnnecessaryVertices?.(gltf.scene);
  }
  scene.add(avatar);

  // 用一层 rig 承载位移与缩放：缩放不会把脚底拉离地面
  const rig = new THREE.Group();
  rig.add(avatar);
  scene.add(rig);

  // 归一化尺寸：脚底贴地，按高度自适应相机
  const box = new THREE.Box3().setFromObject(avatar);
  const size = box.getSize(new THREE.Vector3());
  const modelHeight = Math.max(0.5, size.y);
  const footOffset = -box.min.y;
  const distance = modelHeight * 1.75;
  camera.position.set(0, modelHeight * 0.66, distance);
  camera.lookAt(0, modelHeight * 0.62, 0);
  camera.updateProjectionMatrix();

  const expressionManager = vrm?.expressionManager;
  const chest = vrm?.humanoid?.getNormalizedBoneNode('chest');
  const head = vrm?.humanoid?.getNormalizedBoneNode('head');
  const spine = vrm?.humanoid?.getNormalizedBoneNode('spine');

  let scaleFactor = context.scale;
  let baseY = 0;
  const applyScale = () => {
    avatar.scale.setScalar(scaleFactor);
    baseY = footOffset * scaleFactor;
    rig.position.y = baseY;
  };
  applyScale();

  let running = true;
  let pulse: { kind: PetAction; elapsed: number } | undefined;
  let blinkTimer = 2 + Math.random() * 3;
  let blinkPhase = 0;
  const clock = new THREE.Clock();

  const setExpression = (name: string, value: number) => {
    try {
      expressionManager?.setValue(name, value);
    } catch {
      // 模型没有这个表情
    }
  };

  const animate = () => {
    if (!running) {
      return;
    }
    requestAnimationFrame(animate);
    const delta = Math.min(clock.getDelta(), 0.05);
    const time = clock.elapsedTime;

    // 呼吸
    if (chest) {
      chest.rotation.x = Math.sin(time * 1.4) * 0.035;
    }
    if (spine) {
      spine.rotation.z = Math.sin(time * 0.8) * 0.02;
    }
    // 轻微摇头
    if (head) {
      head.rotation.y = Math.sin(time * 0.7) * 0.06;
      head.rotation.x = Math.sin(time * 0.9) * 0.02;
    }

    // 眨眼
    blinkTimer -= delta;
    if (blinkPhase > 0) {
      blinkPhase -= delta;
      setExpression('blink', blinkPhase > 0.06 ? 1 : 0);
    } else if (blinkTimer <= 0) {
      blinkTimer = 2.5 + Math.random() * 4;
      blinkPhase = 0.14;
    }

    let offsetY = Math.sin(time * 1.6) * modelHeight * 0.004;
    let offsetX = 0;
    let roll = 0;

    if (pulse) {
      pulse.elapsed += delta;
      const progress = pulse.elapsed;
      const damp = Math.exp(-progress * 3.2);
      if (pulse.kind === 'happy' || pulse.kind === 'wave') {
        offsetY += Math.abs(Math.sin(progress * 9)) * modelHeight * 0.035 * damp;
        roll = Math.sin(progress * 8) * 0.06 * damp;
      } else if (pulse.kind === 'alert') {
        offsetX = Math.sin(progress * 30) * modelHeight * 0.012 * damp;
      } else if (pulse.kind === 'shy') {
        roll = -0.05 * Math.min(1, progress * 3);
      }
      if (progress > 2) {
        pulse = undefined;
      }
    }

    rig.position.x = offsetX;
    rig.position.y = baseY + offsetY;
    rig.rotation.z = roll;

    vrm?.update(delta);
    renderer.render(scene, camera);
  };
  requestAnimationFrame(animate);

  const resize = () => {
    const nextWidth = Math.max(1, context.container.clientWidth);
    const nextHeight = Math.max(1, context.container.clientHeight);
    renderer.setSize(nextWidth, nextHeight, true);
    camera.aspect = nextWidth / nextHeight;
    camera.updateProjectionMatrix();
  };

  return {
    play(action: PetAction) {
      if (action === 'idle') {
        pulse = undefined;
        setExpression('happy', 0);
        setExpression('surprised', 0);
        return;
      }
      pulse = { kind: action, elapsed: 0 };
      for (const name of EXPRESSION_MAP[action] ?? []) {
        setExpression(name, 0);
      }
      const primary = EXPRESSION_MAP[action]?.[0];
      if (primary) {
        setExpression(primary, 1);
        window.setTimeout(() => setExpression(primary, 0), 2200);
      }
      if (action === 'alert') {
        setExpression('surprised', 1);
        window.setTimeout(() => setExpression('surprised', 0), 1500);
      }
    },
    setScale(next: number) {
      scaleFactor = next;
      applyScale();
    },
    resize,
    destroy() {
      running = false;
      scene.traverse((object) => {
        const mesh = object as THREE.Mesh;
        if (mesh.geometry) {
          mesh.geometry.dispose();
        }
        const material = mesh.material;
        if (Array.isArray(material)) {
          material.forEach((item) => item.dispose());
        } else if (material) {
          material.dispose();
        }
      });
      renderer.dispose();
      canvas.remove();
    },
  };
}

function loadGltf(url: string): Promise<import('three/examples/jsm/loaders/GLTFLoader.js').GLTF> {
  return new Promise((resolve, reject) => {
    const loader = new GLTFLoader();
    loader.register((parser) => new VRMLoaderPlugin(parser));
    loader.load(
      url,
      (gltf) => resolve(gltf),
      undefined,
      (error) => reject(new Error(`3D 模型加载失败：${String(error)}`)),
    );
  });
}
