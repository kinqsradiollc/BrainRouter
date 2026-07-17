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
        const [THREE, { EffectComposer }, { RenderPass }, { UnrealBloomPass }, { OutputPass }] = await Promise.all([
          import("three"),
          import("three/examples/jsm/postprocessing/EffectComposer.js"),
          import("three/examples/jsm/postprocessing/RenderPass.js"),
          import("three/examples/jsm/postprocessing/UnrealBloomPass.js"),
          import("three/examples/jsm/postprocessing/OutputPass.js"),
        ]);
        if (cancelled) return;

        const renderer = new THREE.WebGLRenderer({
          canvas,
          alpha: true,
          antialias: true,
          powerPreference: "high-performance",
        });
        renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.6));
        renderer.outputColorSpace = THREE.SRGBColorSpace;
        renderer.toneMapping = THREE.ACESFilmicToneMapping;
        renderer.toneMappingExposure = 1.12;

        const scene = new THREE.Scene();
        scene.fog = new THREE.FogExp2(0x07080e, 0.07);
        const camera = new THREE.PerspectiveCamera(38, 1, 0.1, 80);
        const cameraDistance = compact ? 9.6 : 8.8;
        camera.position.set(0, 0.3, cameraDistance);

        // Cinema: everything bright blooms. Threshold keeps the dark body out.
        const composer = new EffectComposer(renderer);
        composer.addPass(new RenderPass(scene, camera));
        const bloom = new UnrealBloomPass(new THREE.Vector2(1, 1), 0.95, 0.85, 0.18);
        composer.addPass(bloom);
        composer.addPass(new OutputPass());

        const root = new THREE.Group();
        root.rotation.set(-0.12, -0.14, 0.03);
        scene.add(root);

        scene.add(new THREE.HemisphereLight(0xb7b0ff, 0x06070b, 1.15));
        const violetLight = new THREE.PointLight(0x8b7cff, 24, 18, 1.6);
        violetLight.position.set(3.4, 3.6, 4.5);
        scene.add(violetLight);
        const cyanLight = new THREE.PointLight(0x4dd8ff, 12, 15, 1.8);
        cyanLight.position.set(-4.2, -1.4, 3.2);
        scene.add(cyanLight);

        const core = new THREE.Group();
        root.add(core);
        const coreMaterial = new THREE.MeshPhysicalMaterial({
          color: 0x14151f,
          emissive: 0x4b3fa0,
          emissiveIntensity: 0.72,
          metalness: 0.42,
          roughness: 0.2,
          clearcoat: 1,
          clearcoatRoughness: 0.16,
        });
        const coreMesh = new THREE.Mesh(new THREE.IcosahedronGeometry(1.08, 3), coreMaterial);
        core.add(coreMesh);
        const coreWire = new THREE.Mesh(
          new THREE.IcosahedronGeometry(1.34, 2),
          new THREE.MeshBasicMaterial({ color: 0xbdb4ff, wireframe: true, transparent: true, opacity: 0.09 }),
        );
        core.add(coreWire);

        // Fresnel energy shell — rim-lit atmosphere that bloom turns into a corona.
        const fresnelMaterial = new THREE.ShaderMaterial({
          transparent: true,
          depthWrite: false,
          blending: THREE.AdditiveBlending,
          side: THREE.BackSide,
          uniforms: { uColor: { value: new THREE.Color(0x7c6bff) }, uTime: { value: 0 } },
          vertexShader: `
            varying float vRim;
            uniform float uTime;
            void main() {
              vec3 transformed = position * (1.0 + 0.012 * sin(uTime * 1.6 + position.y * 4.0));
              vec4 worldPosition = modelMatrix * vec4(transformed, 1.0);
              vec3 worldNormal = normalize(mat3(modelMatrix) * normal);
              vec3 viewDirection = normalize(cameraPosition - worldPosition.xyz);
              vRim = pow(1.0 - abs(dot(worldNormal, viewDirection)), 2.6);
              gl_Position = projectionMatrix * viewMatrix * worldPosition;
            }
          `,
          fragmentShader: `
            varying float vRim;
            uniform vec3 uColor;
            void main() { gl_FragColor = vec4(uColor, vRim * 0.55); }
          `,
        });
        const fresnelShell = new THREE.Mesh(new THREE.SphereGeometry(1.5, 48, 32), fresnelMaterial);
        core.add(fresnelShell);

        const ringConfigs = [
          { radius: 2.15, x: 1.06, y: 0.12, z: 0.28, opacity: 0.34 },
          { radius: 2.72, x: 0.26, y: 1.12, z: -0.18, opacity: 0.26 },
          { radius: 3.18, x: 1.42, y: 0.36, z: 0.7, opacity: 0.2 },
        ];
        const rings = ringConfigs.map((config) => {
          const ring = new THREE.Mesh(
            new THREE.TorusGeometry(config.radius, 0.0085, 8, 200),
            new THREE.MeshBasicMaterial({ color: 0xa9a1ed, transparent: true, opacity: config.opacity, blending: THREE.AdditiveBlending, depthWrite: false }),
          );
          ring.rotation.set(config.x, config.y, config.z);
          root.add(ring);
          return ring;
        });

        const nodePositions = [
          new THREE.Vector3(-3.25, 2.05, 0.1),
          new THREE.Vector3(3.35, 1.82, -0.45),
          new THREE.Vector3(-3.48, -0.5, 0.3),
          new THREE.Vector3(3.28, -1.78, 0.45),
          new THREE.Vector3(-2.42, -2.42, -0.38),
          new THREE.Vector3(2.82, 0.04, 0.72),
        ];
        const nodeColors = [0xbdb4ff, 0x76a7ff, 0x4dd8ff, 0xff8b73, 0xe5e7eb, 0x86d58b];
        // Comets ride curved energy conduits, each with a fading tail. Bloom does
        // the rest — a bright head over an additive curve reads as light in motion.
        const TAIL = 7;
        const pulses: Array<{
          head: InstanceType<typeof THREE.Mesh>;
          tail: Array<InstanceType<typeof THREE.Mesh>>;
          curve: InstanceType<typeof THREE.QuadraticBezierCurve3>;
          offset: number;
          speed: number;
        }> = [];

        nodePositions.forEach((position, index) => {
          const color = nodeColors[index];
          // Curved conduit: lift the midpoint out of plane so paths arc like orbits.
          const lift = new THREE.Vector3(position.y * 0.22, -position.x * 0.16, 0.9 + (index % 3) * 0.28);
          const control = position.clone().multiplyScalar(0.5).add(lift);
          const curve = new THREE.QuadraticBezierCurve3(new THREE.Vector3(0, 0, 0), control, position);
          const conduit = new THREE.Mesh(
            new THREE.TubeGeometry(curve, 40, 0.008, 6, false),
            new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.16, blending: THREE.AdditiveBlending, depthWrite: false }),
          );
          root.add(conduit);

          const node = new THREE.Mesh(
            new THREE.OctahedronGeometry(0.13, 1),
            new THREE.MeshStandardMaterial({ color, emissive: color, emissiveIntensity: 2.1, roughness: 0.3 }),
          );
          node.position.copy(position);
          root.add(node);

          const halo = new THREE.Mesh(
            new THREE.SphereGeometry(0.3, 16, 12),
            new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.05, blending: THREE.AdditiveBlending, depthWrite: false }),
          );
          halo.position.copy(position);
          root.add(halo);

          const head = new THREE.Mesh(
            new THREE.SphereGeometry(0.05, 12, 8),
            new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.95 }),
          );
          root.add(head);
          const tail = Array.from({ length: TAIL }, (_, tailIndex) => {
            const segment = new THREE.Mesh(
              new THREE.SphereGeometry(0.034 - tailIndex * 0.003, 8, 6),
              new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false }),
            );
            root.add(segment);
            return segment;
          });
          pulses.push({ head, tail, curve, offset: index / nodePositions.length, speed: 0.14 + (index % 3) * 0.025 });
        });

        // Two star layers at different depths — parallax dust the bloom can catch.
        const makeStars = (count: number, spread: number, size: number, opacity: number) => {
          const positions = new Float32Array(count * 3);
          for (let index = 0; index < count; index += 1) {
            const angle = index * 2.399963;
            const radius = 2.6 + ((index * 47) % 1000) / (1000 / spread);
            positions[index * 3] = Math.cos(angle) * radius;
            positions[index * 3 + 1] = Math.sin(angle * 1.37) * radius * 0.6;
            positions[index * 3 + 2] = -3.2 + ((index * 31) % 900) / 160;
          }
          const geometry = new THREE.BufferGeometry();
          geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
          const points = new THREE.Points(
            geometry,
            new THREE.PointsMaterial({ color: 0xb9b6d5, size, transparent: true, opacity, depthWrite: false, blending: THREE.AdditiveBlending }),
          );
          scene.add(points);
          return points;
        };
        const starsNear = makeStars(260, 3.4, 0.03, 0.5);
        const starsFar = makeStars(420, 5.2, 0.018, 0.3);

        const grid = new THREE.GridHelper(12, 24, 0x625a96, 0x1e1f2b);
        grid.position.set(0, -2.75, -1.4);
        (grid.material as Material).transparent = true;
        (grid.material as Material).opacity = 0.12;
        scene.add(grid);

        let frame = 0;
        let visible = true;
        let reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
        let pointerX = 0;
        let pointerY = 0;

        const resize = () => {
          const width = Math.max(host.clientWidth, 1);
          const height = Math.max(host.clientHeight, 1);
          renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.6));
          renderer.setSize(width, height, false);
          composer.setSize(width, height);
          camera.aspect = width / height;
          camera.updateProjectionMatrix();
          composer.render();
        };

        const renderFrame = (now: number) => {
          frame = 0;
          if (!visible || reducedMotion) return;
          const time = now * 0.001;
          // Cinematic camera: slow orbital drift + breathing distance, pointer parallax on top.
          const drift = time * 0.05;
          camera.position.x = Math.sin(drift) * 0.55 + pointerX * 0.35;
          camera.position.y = 0.3 + Math.sin(time * 0.11) * 0.18 - pointerY * 0.28;
          camera.position.z = cameraDistance + Math.sin(time * 0.07) * 0.25;
          camera.lookAt(0, 0, 0);
          root.rotation.y = -0.14 + time * 0.02 + pointerX * 0.06;
          core.rotation.y = time * 0.18;
          core.rotation.x = Math.sin(time * 0.42) * 0.08;
          coreWire.rotation.y = -time * 0.12;
          fresnelMaterial.uniforms.uTime.value = time;
          rings[0].rotation.z = ringConfigs[0].z + time * 0.1;
          rings[1].rotation.z = ringConfigs[1].z - time * 0.075;
          rings[2].rotation.y = ringConfigs[2].y + time * 0.06;
          starsNear.rotation.z = time * 0.01;
          starsFar.rotation.z = -time * 0.006;
          for (const pulse of pulses) {
            const progress = (time * pulse.speed + pulse.offset) % 1;
            const intensity = Math.sin(progress * Math.PI);
            pulse.head.position.copy(pulse.curve.getPoint(progress));
            pulse.head.scale.setScalar(0.75 + intensity * 0.75);
            (pulse.head.material as InstanceType<typeof THREE.MeshBasicMaterial>).opacity = intensity * 0.95;
            pulse.tail.forEach((segment, tailIndex) => {
              const trail = Math.max(progress - (tailIndex + 1) * 0.028, 0);
              segment.position.copy(pulse.curve.getPoint(trail));
              (segment.material as InstanceType<typeof THREE.MeshBasicMaterial>).opacity =
                intensity * Math.max(0.5 - tailIndex * 0.07, 0) * (trail > 0 ? 1 : 0);
            });
          }
          composer.render();
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
            composer.render(); // one graded still frame, no motion
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
          bloom.dispose();
          composer.dispose();
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
