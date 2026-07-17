"use client";

import { useEffect, useRef } from "react";
import type { BufferGeometry, Material, Object3D, Scene, Texture, WebGLRenderer } from "three";
import styles from "./productOrbit.module.css";

const OPERATION_NODES = [
  { slot: "workbench", label: "Agent workbench", detail: "plan · build" },
  { slot: "sources", label: "Connected sources", detail: "repos · tools" },
  { slot: "knowledge", label: "Knowledge", detail: "memory · evidence" },
  { slot: "testing", label: "Security tests", detail: "checks · pentests" },
  { slot: "reviews", label: "PR reviews", detail: "findings · fixes" },
  { slot: "automation", label: "Automation", detail: "hooks · schedules" },
] as const;

type DisposableObject = Object3D & {
  geometry?: BufferGeometry;
  material?: Material | Material[];
};

function disposeMaterial(material: Material): void {
  for (const value of Object.values(material)) {
    if (value && typeof value === "object" && "isTexture" in value) (value as Texture).dispose();
  }
  material.dispose();
}

function disposeScene(scene: Scene, renderer: WebGLRenderer): void {
  scene.traverse((object) => {
    const disposable = object as DisposableObject;
    disposable.geometry?.dispose();
    if (Array.isArray(disposable.material)) disposable.material.forEach(disposeMaterial);
    else if (disposable.material) disposeMaterial(disposable.material);
  });
  renderer.dispose();
}

export function ProductOrbit({ compact = false }: { compact?: boolean }) {
  const hostRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const host = hostRef.current;
    const canvas = canvasRef.current;
    if (!host || !canvas) return;

    let cancelled = false;
    let teardown = () => undefined;

    void (async () => {
      try {
        const THREE = await import("three");
        if (cancelled) return;

        const renderer = new THREE.WebGLRenderer({
          canvas,
          alpha: true,
          antialias: true,
          powerPreference: "high-performance",
        });
        renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.75));
        renderer.outputColorSpace = THREE.SRGBColorSpace;
        renderer.toneMapping = THREE.ACESFilmicToneMapping;
        renderer.toneMappingExposure = 1.1;

        const scene = new THREE.Scene();
        scene.fog = new THREE.FogExp2(0x08090f, 0.085);
        const camera = new THREE.PerspectiveCamera(38, 1, 0.1, 80);
        camera.position.set(0, 0.25, compact ? 9.4 : 8.6);

        const root = new THREE.Group();
        root.rotation.set(-0.08, -0.12, 0.025);
        scene.add(root);

        scene.add(new THREE.HemisphereLight(0xb7b0ff, 0x06070b, 1.45));
        const violetLight = new THREE.PointLight(0x8b7cff, 26, 18, 1.6);
        violetLight.position.set(3.4, 3.6, 4.5);
        scene.add(violetLight);
        const cyanLight = new THREE.PointLight(0x4dd8ff, 14, 15, 1.8);
        cyanLight.position.set(-4.2, -1.4, 3.2);
        scene.add(cyanLight);

        const core = new THREE.Group();
        root.add(core);
        const coreMaterial = new THREE.MeshPhysicalMaterial({
          color: 0x181925,
          emissive: 0x3f347f,
          emissiveIntensity: 0.58,
          metalness: 0.48,
          roughness: 0.18,
          clearcoat: 1,
          clearcoatRoughness: 0.16,
        });
        const coreMesh = new THREE.Mesh(new THREE.IcosahedronGeometry(1.08, 3), coreMaterial);
        core.add(coreMesh);
        const coreWire = new THREE.Mesh(
          new THREE.IcosahedronGeometry(1.34, 2),
          new THREE.MeshBasicMaterial({ color: 0xbdb4ff, wireframe: true, transparent: true, opacity: 0.1 }),
        );
        core.add(coreWire);

        const shell = new THREE.Mesh(
          new THREE.SphereGeometry(1.64, 42, 28),
          new THREE.MeshBasicMaterial({ color: 0x8b7cff, wireframe: true, transparent: true, opacity: 0.045 }),
        );
        core.add(shell);

        const ringMaterial = new THREE.MeshBasicMaterial({ color: 0xa9a1ed, transparent: true, opacity: 0.21 });
        const ringConfigs = [
          { radius: 2.15, x: 1.06, y: 0.12, z: 0.28 },
          { radius: 2.72, x: 0.26, y: 1.12, z: -0.18 },
          { radius: 3.18, x: 1.42, y: 0.36, z: 0.7 },
        ];
        const rings = ringConfigs.map((config) => {
          const ring = new THREE.Mesh(new THREE.TorusGeometry(config.radius, 0.012, 8, 160), ringMaterial.clone());
          ring.rotation.set(config.x, config.y, config.z);
          root.add(ring);
          return ring;
        });
        ringMaterial.dispose();

        const nodePositions = [
          new THREE.Vector3(-3.25, 2.05, 0.1),
          new THREE.Vector3(3.35, 1.82, -0.45),
          new THREE.Vector3(-3.48, -0.5, 0.3),
          new THREE.Vector3(3.28, -1.78, 0.45),
          new THREE.Vector3(-2.42, -2.42, -0.38),
          new THREE.Vector3(2.82, 0.04, 0.72),
        ];
        const nodeColors = [0xbdb4ff, 0x76a7ff, 0x4dd8ff, 0xff8b73, 0xe5e7eb, 0x86d58b];
        const pulseMaterial = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.9 });
        const pulses: Array<{ mesh: InstanceType<typeof THREE.Mesh>; to: InstanceType<typeof THREE.Vector3>; offset: number }> = [];

        nodePositions.forEach((position, index) => {
          const color = nodeColors[index];
          const lineGeometry = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), position]);
          const line = new THREE.Line(
            lineGeometry,
            new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.18 }),
          );
          root.add(line);

          const node = new THREE.Mesh(
            new THREE.OctahedronGeometry(0.13, 1),
            new THREE.MeshStandardMaterial({ color, emissive: color, emissiveIntensity: 1.3, roughness: 0.32 }),
          );
          node.position.copy(position);
          root.add(node);

          const halo = new THREE.Mesh(
            new THREE.SphereGeometry(0.28, 16, 12),
            new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.07, depthWrite: false }),
          );
          halo.position.copy(position);
          root.add(halo);

          const pulse = new THREE.Mesh(new THREE.SphereGeometry(0.045, 12, 8), pulseMaterial.clone());
          root.add(pulse);
          pulses.push({ mesh: pulse, to: position, offset: index / nodePositions.length });
        });
        pulseMaterial.dispose();

        const starPositions = new Float32Array(180 * 3);
        for (let index = 0; index < 180; index += 1) {
          const angle = index * 2.399963;
          const radius = 3.4 + ((index * 47) % 100) / 27;
          starPositions[index * 3] = Math.cos(angle) * radius;
          starPositions[index * 3 + 1] = Math.sin(angle * 1.37) * radius * 0.58;
          starPositions[index * 3 + 2] = -2.5 + ((index * 31) % 90) / 22;
        }
        const starsGeometry = new THREE.BufferGeometry();
        starsGeometry.setAttribute("position", new THREE.BufferAttribute(starPositions, 3));
        const stars = new THREE.Points(
          starsGeometry,
          new THREE.PointsMaterial({ color: 0xb9b6d5, size: 0.025, transparent: true, opacity: 0.36, depthWrite: false }),
        );
        scene.add(stars);

        const grid = new THREE.GridHelper(12, 24, 0x625a96, 0x252633);
        grid.position.set(0, -2.75, -1.4);
        (grid.material as Material).transparent = true;
        (grid.material as Material).opacity = 0.16;
        scene.add(grid);

        let frame = 0;
        let visible = true;
        let reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
        let pointerX = 0;
        let pointerY = 0;

        const resize = () => {
          const width = Math.max(host.clientWidth, 1);
          const height = Math.max(host.clientHeight, 1);
          renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.75));
          renderer.setSize(width, height, false);
          camera.aspect = width / height;
          camera.updateProjectionMatrix();
          renderer.render(scene, camera);
        };

        const renderFrame = (now: number) => {
          frame = 0;
          if (!visible || reducedMotion) return;
          const time = now * 0.001;
          root.rotation.y += (pointerX * 0.13 - root.rotation.y) * 0.025;
          root.rotation.x += (-0.08 + pointerY * 0.08 - root.rotation.x) * 0.025;
          core.rotation.y = time * 0.18;
          core.rotation.x = Math.sin(time * 0.42) * 0.08;
          coreWire.rotation.y = -time * 0.12;
          shell.rotation.x = time * 0.08;
          rings[0].rotation.z = ringConfigs[0].z + time * 0.1;
          rings[1].rotation.z = ringConfigs[1].z - time * 0.075;
          rings[2].rotation.y = ringConfigs[2].y + time * 0.06;
          stars.rotation.z = time * 0.008;
          for (const pulse of pulses) {
            const progress = (time * 0.18 + pulse.offset) % 1;
            pulse.mesh.position.copy(pulse.to).multiplyScalar(progress);
            pulse.mesh.scale.setScalar(0.7 + Math.sin(progress * Math.PI) * 0.8);
            (pulse.mesh.material as InstanceType<typeof THREE.MeshBasicMaterial>).opacity = Math.sin(progress * Math.PI) * 0.9;
          }
          renderer.render(scene, camera);
          frame = window.requestAnimationFrame(renderFrame);
        };
        const startAnimation = () => {
          if (!frame && visible && !reducedMotion) frame = window.requestAnimationFrame(renderFrame);
        };
        const stopAnimation = () => {
          if (frame) window.cancelAnimationFrame(frame);
          frame = 0;
        };

        const onPointerMove = (event: PointerEvent) => {
          const bounds = host.getBoundingClientRect();
          pointerX = ((event.clientX - bounds.left) / Math.max(bounds.width, 1) - 0.5) * 2;
          pointerY = ((event.clientY - bounds.top) / Math.max(bounds.height, 1) - 0.5) * 2;
        };
        const onPointerLeave = () => { pointerX = 0; pointerY = 0; };
        const motionQuery = window.matchMedia("(prefers-reduced-motion: reduce)");
        const onMotionChange = (event: MediaQueryListEvent) => {
          reducedMotion = event.matches;
          if (reducedMotion) {
            stopAnimation();
            renderer.render(scene, camera);
          } else startAnimation();
        };
        const onContextLost = (event: Event) => {
          event.preventDefault();
          stopAnimation();
          host.dataset.render = "fallback";
        };
        const onContextRestored = () => {
          host.dataset.render = "webgl";
          resize();
          startAnimation();
        };

        const resizeObserver = new ResizeObserver(resize);
        const visibilityObserver = new IntersectionObserver(([entry]) => {
          visible = entry?.isIntersecting ?? true;
          if (visible) startAnimation();
          else stopAnimation();
        }, { rootMargin: "120px" });
        resizeObserver.observe(host);
        visibilityObserver.observe(host);
        host.addEventListener("pointermove", onPointerMove, { passive: true });
        host.addEventListener("pointerleave", onPointerLeave, { passive: true });
        canvas.addEventListener("webglcontextlost", onContextLost);
        canvas.addEventListener("webglcontextrestored", onContextRestored);
        motionQuery.addEventListener("change", onMotionChange);
        host.dataset.render = "webgl";
        resize();
        startAnimation();

        teardown = () => {
          stopAnimation();
          resizeObserver.disconnect();
          visibilityObserver.disconnect();
          host.removeEventListener("pointermove", onPointerMove);
          host.removeEventListener("pointerleave", onPointerLeave);
          canvas.removeEventListener("webglcontextlost", onContextLost);
          canvas.removeEventListener("webglcontextrestored", onContextRestored);
          motionQuery.removeEventListener("change", onMotionChange);
          disposeScene(scene, renderer);
        };
      } catch {
        host.dataset.render = "fallback";
      }
    })();

    return () => {
      cancelled = true;
      teardown();
    };
  }, [compact]);

  return (
    <div
      ref={hostRef}
      className={`${styles.scene}${compact ? ` ${styles.compact}` : ""}`}
      data-testid="product-orbit"
      data-render="loading"
      role="img"
      aria-label="Three-dimensional BrainRouter operations graph connecting the agent workbench, sources, knowledge, security tests, pull request reviews, and automation through shared task state."
    >
      <canvas ref={canvasRef} className={styles.canvas} aria-hidden="true" />
      <div className={styles.fallbackCore} aria-hidden="true"><i /><i /><i /></div>
      <div className={styles.scanline} aria-hidden="true" />

      <div className={styles.sceneHeader} aria-hidden="true">
        <span><i /> Operations graph</span>
        <small>Three.js · shared state</small>
      </div>

      <div className={styles.coreLabel} aria-hidden="true">
        <span>BR / CORE</span>
        <strong>Agent operations</strong>
        <small>shared task router</small>
      </div>

      <div className={styles.nodes} aria-hidden="true">
        {OPERATION_NODES.map((node) => (
          <span key={node.slot} className={styles.node} data-slot={node.slot}>
            <i />{node.label}<small>{node.detail}</small>
          </span>
        ))}
      </div>

      <div className={styles.activityRail} aria-hidden="true">
        <span data-signal="review"><i />PR review ready</span>
        <span data-signal="test"><i />test suite passed</span>
        <span data-signal="context"><i />context synchronized</span>
      </div>
    </div>
  );
}
