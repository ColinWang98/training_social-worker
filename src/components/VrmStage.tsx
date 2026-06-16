import { useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { VRM, VRMHumanBoneName, VRMLoaderPlugin, VRMUtils } from '@pixiv/three-vrm';
import {
  createVRMAnimationClip,
  VRMAnimation,
  VRMAnimationLoaderPlugin,
} from '@pixiv/three-vrm-animation';
import {
  ArkitBlendshapeName,
  ArkitBlendshapeWeights,
  ExpressionWeights,
} from '../lib/avatarConfig';
import {
  buildCantoneseVisemeTimeline,
  CantoneseViseme,
  expressionProfileForAffect,
  visemeWeightsForTime,
} from '../lib/arkitExpressions';
import {
  AffectLabel,
  AvatarDirectivePriority,
  AvatarGazePattern,
  AvatarPerformancePlan,
  MotionCue,
} from '../lib/interviewTypes';
import type { AvatarBlendshapeDebug } from '../App';

type StageStatus = {
  avatarLoaded: boolean;
  vrmaLoaded: boolean;
  message: string;
  blendshapeDebug?: AvatarBlendshapeDebug;
};

type AvatarClipManifestEntry = {
  id: string;
  file: string;
  playbackMask: 'upper_body';
  seatedRuntime: boolean;
  autoLoad: boolean;
};

type AvatarClipManifest = {
  clips: AvatarClipManifestEntry[];
};

const ENABLE_SEATED_BONE_RUNTIME = true;

type VrmStageProps = {
  avatarPath: string;
  avatarFallbackPaths?: string[];
  avatarLabel?: string;
  expressionWeights: ExpressionWeights;
  expressionProfile?: AffectLabel;
  motionIntensity: number;
  motionCue: MotionCue;
  caseBaselineMood?: AffectLabel;
  caseRestingCue?: MotionCue;
  caseGazePattern?: AvatarGazePattern;
  caseIdleIntensity?: number;
  baselineMood?: AffectLabel;
  gesture?: MotionCue;
  transitionMs?: number;
  holdMs?: number;
  priority?: AvatarDirectivePriority;
  performancePlan?: AvatarPerformancePlan;
  reactionKey: string;
  speechLevel: number;
  visemePlayback: {
    text: string;
    startedAtMs: number;
    durationMs: number;
    active: boolean;
  };
  autoBlink: boolean;
  vrmaFile: File | null;
  onStatusChange: (status: StageStatus) => void;
};

export function VrmStage({
  avatarPath,
  avatarFallbackPaths,
  avatarLabel,
  expressionWeights,
  expressionProfile,
  motionIntensity,
  motionCue,
  caseBaselineMood,
  caseRestingCue,
  caseGazePattern,
  caseIdleIntensity,
  baselineMood,
  gesture,
  transitionMs,
  holdMs,
  priority,
  performancePlan,
  reactionKey,
  speechLevel,
  visemePlayback,
  autoBlink,
  vrmaFile,
  onStatusChange,
}: VrmStageProps) {
  const [stageNotice, setStageNotice] = useState('正在載入 Avatar...');
  const avatarFallbackKey = avatarFallbackPaths?.join('|') ?? '';
  const containerRef = useRef<HTMLDivElement | null>(null);
  const vrmRef = useRef<VRM | null>(null);
  const mixerRef = useRef<THREE.AnimationMixer | null>(null);
  const actionRef = useRef<THREE.AnimationAction | null>(null);
  const expressionRef = useRef(expressionWeights);
  const currentExpressionRef = useRef<ExpressionWeights>({});
  const expressionProfileRef = useRef<AffectLabel | undefined>(expressionProfile);
  const arkitControllerRef = useRef<ReturnType<typeof createMorphTargetExpressionController> | null>(null);
  const visemePlaybackRef = useRef(visemePlayback);
  const currentMouthRef = useRef(0);
  const motionIntensityRef = useRef(motionIntensity);
  const motionCueRef = useRef<MotionCue>(motionCue);
  const caseBaselineMoodRef = useRef<AffectLabel | undefined>(caseBaselineMood);
  const caseRestingCueRef = useRef<MotionCue | undefined>(caseRestingCue);
  const caseGazePatternRef = useRef<AvatarGazePattern>(caseGazePattern ?? 'camera_soft');
  const caseIdleIntensityRef = useRef(caseIdleIntensity ?? 1);
  const baselineMoodRef = useRef<AffectLabel | undefined>(baselineMood);
  const gestureRef = useRef<MotionCue | undefined>(gesture);
  const transitionMsRef = useRef(transitionMs ?? 700);
  const holdMsRef = useRef(holdMs ?? 2500);
  const priorityRef = useRef<AvatarDirectivePriority>(priority ?? 'reaction');
  const performancePlanRef = useRef<AvatarPerformancePlan | undefined>(performancePlan);
  const clipManifestRef = useRef<AvatarClipManifest | null>(null);
  const policyActionRef = useRef<THREE.AnimationAction | null>(null);
  const policyActionActiveRef = useRef(false);
  const manualVrmaActiveRef = useRef(false);
  const activeReactionInstanceRef = useRef<string | null>(null);
  const performanceControllerRef = useRef(createAvatarPerformanceController());
  const motionControllerRef = useRef(createAvatarMotionController());
  const safePoseRuntimeRef = useRef(createSafeNormalizedPoseRuntime());
  const seatedRuntimeAvailableRef = useRef(true);
  const wasUpperBodyAnimationActiveRef = useRef(false);
  const idleRandomControllerRef = useRef(createIdleRandomController());
  const lastArkitDebugAtRef = useRef(0);
  const reactionKeyRef = useRef(reactionKey);
  const speechLevelRef = useRef(speechLevel);
  const autoBlinkRef = useRef(autoBlink);

  useEffect(() => {
    expressionRef.current = expressionWeights;
  }, [expressionWeights]);

  useEffect(() => {
    expressionProfileRef.current = expressionProfile;
  }, [expressionProfile]);

  useEffect(() => {
    visemePlaybackRef.current = visemePlayback;
  }, [visemePlayback]);

  useEffect(() => {
    motionCueRef.current = motionCue;
  }, [motionCue]);

  useEffect(() => {
    caseBaselineMoodRef.current = caseBaselineMood;
  }, [caseBaselineMood]);

  useEffect(() => {
    caseRestingCueRef.current = caseRestingCue;
  }, [caseRestingCue]);

  useEffect(() => {
    caseGazePatternRef.current = caseGazePattern ?? 'camera_soft';
  }, [caseGazePattern]);

  useEffect(() => {
    caseIdleIntensityRef.current = caseIdleIntensity ?? 1;
  }, [caseIdleIntensity]);

  useEffect(() => {
    baselineMoodRef.current = baselineMood;
  }, [baselineMood]);

  useEffect(() => {
    gestureRef.current = gesture;
  }, [gesture]);

  useEffect(() => {
    transitionMsRef.current = transitionMs ?? 700;
  }, [transitionMs]);

  useEffect(() => {
    holdMsRef.current = holdMs ?? 2500;
  }, [holdMs]);

  useEffect(() => {
    priorityRef.current = priority ?? 'reaction';
  }, [priority]);

  useEffect(() => {
    performancePlanRef.current = performancePlan;
    if (!performancePlan) {
      policyActionRef.current?.fadeOut(0.25);
      policyActionRef.current = null;
      policyActionActiveRef.current = false;
      activeReactionInstanceRef.current = null;
    }
  }, [performancePlan]);

  useEffect(() => {
    motionIntensityRef.current = motionIntensity;
  }, [motionIntensity]);

  useEffect(() => {
    if (reactionKeyRef.current === reactionKey) return;
    reactionKeyRef.current = reactionKey;
  }, [reactionKey]);

  useEffect(() => {
    autoBlinkRef.current = autoBlink;
  }, [autoBlink]);

  useEffect(() => {
    speechLevelRef.current = speechLevel;
  }, [speechLevel]);

  useEffect(() => {
    if (!containerRef.current) return;

    let disposed = false;
    let frameId = 0;
    let tickCount = 0;
    let lastDebugAt = 0;
    setStageNotice('正在載入 Avatar...');

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0xf7f8fb);

    const camera = new THREE.PerspectiveCamera(26, 1, 0.1, 100);
    camera.position.set(0, 1.38, 1.38);
    const gazeTarget = new THREE.Object3D();
    gazeTarget.position.set(0, 1.32, 1.15);
    scene.add(gazeTarget);

    const renderer = new THREE.WebGLRenderer({
      antialias: true,
      alpha: false,
    });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.shadowMap.enabled = true;

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.target.set(0, 1.22, 0);
    controls.enableDamping = true;
    controls.enablePan = false;
    controls.enableZoom = false;
    controls.enableRotate = false;
    controls.minDistance = 1.25;
    controls.maxDistance = 5.5;
    controls.minPolarAngle = Math.PI * 0.43;
    controls.maxPolarAngle = Math.PI * 0.51;

    const keyLight = new THREE.DirectionalLight(0xffffff, 2.2);
    keyLight.position.set(2.5, 3.2, 2);
    keyLight.castShadow = true;
    scene.add(keyLight);

    const fillLight = new THREE.HemisphereLight(0xffffff, 0xa6b0c3, 1.9);
    scene.add(fillLight);

    const floor = new THREE.Mesh(
      new THREE.CircleGeometry(1.15, 64),
      new THREE.MeshStandardMaterial({
        color: 0xe8ebf0,
        roughness: 0.82,
        metalness: 0,
      }),
    );
    floor.rotation.x = -Math.PI / 2;
    floor.position.y = 0.005;
    floor.receiveShadow = true;
    scene.add(floor);

    const chair = createSimpleChair();
    scene.add(chair);

    containerRef.current.appendChild(renderer.domElement);

    const resize = () => {
      if (!containerRef.current) return;
      const hostRect = containerRef.current.getBoundingClientRect();
      const parentRect = containerRef.current.parentElement?.getBoundingClientRect();
      const width = Math.max(
        1,
        Math.round(hostRect.width || containerRef.current.clientWidth || parentRect?.width || 0),
      );
      const height = Math.max(
        1,
        Math.round(hostRect.height || containerRef.current.clientHeight || parentRect?.height || 0),
      );
      renderer.setSize(width, height, false);
      camera.aspect = width / height;
      camera.updateProjectionMatrix();
    };
    const resizeObserver = new ResizeObserver(resize);

    const loader = new GLTFLoader();
    loader.register((parser) => new VRMLoaderPlugin(parser));

    const loadAvatar = (modelPath: string, fallbackPaths: string[] = []) => {
      loader.load(
        modelPath,
        (gltf) => {
          if (disposed) return;
          const vrm = gltf.userData.vrm as VRM | undefined;
          if (!vrm) {
            throw new Error(`${modelPath} was parsed as glTF, but no VRM extension was found.`);
          }

          const postLoadWarnings: string[] = [];
          const isVrm0Asset = vrm.meta?.metaVersion === '0';
          if (isVrm0Asset) {
            try {
              VRMUtils.rotateVRM0(vrm);
            } catch (error) {
              postLoadWarnings.push(`VRM0 rotation skipped: ${error instanceof Error ? error.message : String(error)}`);
            }
          }

          vrm.scene.visible = true;
          vrm.scene.position.set(0, 0, -0.02);
          vrm.scene.scale.setScalar(1);
          vrm.scene.traverse((object: THREE.Object3D) => {
            object.visible = true;
            object.layers.set(0);
            object.frustumCulled = false;
            if ('castShadow' in object) object.castShadow = true;
            if ((object as THREE.Mesh).isMesh) {
              normalizeRenderableMesh(object as THREE.Mesh);
            }
          });
          scene.add(vrm.scene);
          vrmRef.current = vrm;
          publishVrmStageDebug({
            avatarLoaded: true,
            loadPath: modelPath,
            sceneChildren: scene.children.length,
            vrmChildren: vrm.scene.children.length,
            message: 'avatar scene added',
          });
          vrmRef.current.scene.userData.rigProfile = isVrm0Asset ? 'vrm0Conservative' : 'default';
          currentExpressionRef.current = {};
          currentMouthRef.current = 0;
          seatedRuntimeAvailableRef.current = true;

          try {
            const initialPose = buildSeatedPose(vrm, 'neutral', 0.55, 0, 0, true, undefined, isVrm0Asset);
            applySeatedPose(vrm, initialPose);
            safePoseRuntimeRef.current.reset(initialPose);
          } catch (error) {
            postLoadWarnings.push(`initial seated pose skipped: ${error instanceof Error ? error.message : String(error)}`);
          }
          wasUpperBodyAnimationActiveRef.current = false;
          if (!frameAvatarUpperBody(camera, controls, gazeTarget, vrm.scene)) {
            postLoadWarnings.push('camera auto-frame skipped: invalid model bounds');
          }

          try {
            if (vrm.lookAt) {
              vrm.lookAt.target = gazeTarget;
            }
          } catch (error) {
            postLoadWarnings.push(`lookAt skipped: ${error instanceof Error ? error.message : String(error)}`);
          }

          try {
            arkitControllerRef.current = createMorphTargetExpressionController(vrm.scene, modelPath);
          } catch (error) {
            postLoadWarnings.push(`ARKit controller skipped: ${error instanceof Error ? error.message : String(error)}`);
            arkitControllerRef.current = null;
          }
          const arkitAvailable = (arkitControllerRef.current?.arkitTargetCount ?? 0) >= 52;
          setStageNotice('');
          const warningSuffix = postLoadWarnings.length ? ` (${postLoadWarnings.join('; ')})` : '';
          onStatusChange({
            avatarLoaded: true,
            vrmaLoaded: false,
            message: arkitAvailable
              ? `Loaded ${avatarLabel ?? modelPath} with ARKit 52 blendshape targets.${warningSuffix}`
              : `Loaded ${avatarLabel ?? modelPath} through @pixiv/three-vrm; ARKit blendshapes unavailable.${warningSuffix}`,
            blendshapeDebug: arkitControllerRef.current
              ? arkitDebugSnapshot(
                modelPath,
                arkitControllerRef.current,
                expressionProfileRef.current ?? 'neutral',
                'none',
                '',
                {},
              )
              : undefined,
          });
        },
      undefined,
      (error) => {
        const [nextFallback, ...remainingFallbacks] = fallbackPaths;
        if (nextFallback) {
          loadAvatar(nextFallback, remainingFallbacks);
          return;
        }
        setStageNotice(`Avatar 載入失敗：${error instanceof Error ? error.message : String(error)}`);
        onStatusChange({
          avatarLoaded: false,
          vrmaLoaded: false,
          message: `Failed to load VRM: ${String(error)}`,
        });
      },
      );
    };

    loadAvatar(avatarPath, avatarFallbackPaths ?? []);

    const clock = new THREE.Clock();

    fetch('/avatar-clips/manifest.json')
      .then((response) => (response.ok ? response.json() : null))
      .then((manifest) => {
        if (!disposed && isAvatarClipManifest(manifest)) {
          clipManifestRef.current = manifest;
        }
      })
      .catch(() => {
        clipManifestRef.current = null;
      });

    const applyExpressions = (elapsed: number, reactionPulse: number, delta: number) => {
      const vrm = vrmRef.current;
      const manager = vrm?.expressionManager;
      if (!manager) return;

      const weights = expressionRef.current;
      const current = currentExpressionRef.current;
      const expressionNames = new Set([...Object.keys(weights), ...Object.keys(current)]);
      manager.resetValues();
      expressionNames.forEach((name) => {
        const baseTarget = weights[name as keyof ExpressionWeights] ?? 0;
        const target = clampExpression(baseTarget * (1 + reactionPulse * 0.35));
        const previous = clampExpression(current[name as keyof ExpressionWeights] ?? 0);
        const next = dampValue(previous, target, delta, expressionTimeConstant(name, target > previous));
        if (next > 0.01) {
          setVrmExpressionValue(manager, name, next);
          current[name as keyof ExpressionWeights] = next;
        } else {
          delete current[name as keyof ExpressionWeights];
        }
      });

      if (autoBlinkRef.current) {
        const phase = elapsed % 4.8;
        const blink =
          phase > 4.46 && phase < 4.62
            ? Math.sin(((phase - 4.46) / 0.16) * Math.PI)
            : 0;
        setVrmExpressionValue(manager, 'blink', Math.max(getVrmExpressionValue(manager, 'blink'), blink));
      }

      const mouth = clampExpression(speechLevelRef.current);
      const mouthTarget = mouth > 0.03 ? mouth * 0.82 : 0;
      currentMouthRef.current = dampValue(
        currentMouthRef.current,
        mouthTarget,
        delta,
        mouthTarget > currentMouthRef.current ? 0.055 : 0.14,
      );
      if (currentMouthRef.current > 0.025) {
        setVrmExpressionValue(manager, 'aa', Math.max(getVrmExpressionValue(manager, 'aa'), currentMouthRef.current));
      }

      manager.update();

      const arkitController = arkitControllerRef.current;
      if (arkitController) {
        const playback = visemePlaybackRef.current;
        const profile = expressionProfileRef.current ?? 'neutral';
        const profileWeights = expressionProfileForAffect(profile, weights, motionIntensityRef.current);
        const timeline = playback.active
          ? buildCantoneseVisemeTimeline(playback.text, playback.durationMs)
          : [];
        const viseme = visemeWeightsForTime(
          timeline,
          performance.now() - playback.startedAtMs,
          speechLevelRef.current,
        );
        const blink =
          autoBlinkRef.current && getVrmExpressionValue(manager, 'blink')
            ? {
              eyeBlinkLeft: getVrmExpressionValue(manager, 'blink'),
              eyeBlinkRight: getVrmExpressionValue(manager, 'blink'),
            }
            : {};
        const arkitWeights = mergeArkitWeights(profileWeights, viseme.weights, blink);
        arkitController.apply(arkitWeights, delta);
        if (elapsed - lastArkitDebugAtRef.current > 1.5) {
          lastArkitDebugAtRef.current = elapsed;
          onStatusChange({
            avatarLoaded: true,
            vrmaLoaded: Boolean(policyActionActiveRef.current || manualVrmaActiveRef.current),
            message: arkitController.arkitTargetCount >= 52
              ? `Loaded ${avatarLabel ?? arkitController.modelPath} with ARKit 52 blendshape targets.`
              : `Loaded ${avatarLabel ?? arkitController.modelPath}; ARKit blendshapes unavailable.`,
            blendshapeDebug: arkitDebugSnapshot(
              arkitController.modelPath,
              arkitController,
              profile,
              viseme.activeViseme,
              viseme.activeChar,
              arkitWeights,
            ),
          });
        }
      }
    };

    const tick = () => {
      const delta = clock.getDelta();
      const elapsed = clock.elapsedTime;
      tickCount += 1;
      let expressionReactionPulse = 0;
      controls.update();
      mixerRef.current?.update(delta);
      if (vrmRef.current) {
        if (tickCount < 120) {
          frameAvatarUpperBody(camera, controls, gazeTarget, vrmRef.current.scene);
        }
        const performanceState = performanceControllerRef.current.update(
          performancePlanRef.current,
          reactionKeyRef.current,
          elapsed,
        );
        const activeCue = activeMotionCue(
          gestureRef.current,
          baselineMoodRef.current,
          motionCueRef.current,
          caseRestingCueRef.current,
          caseBaselineMoodRef.current,
        );
        expressionReactionPulse = performanceState.reactionWeight;
        const activeIntensity = performanceState.reactionWeight > 0
          ? motionIntensityRef.current
          : Math.min(motionIntensityRef.current, caseIdleIntensityRef.current);
        const idlePulse = baselineIdlePulse(
          performanceState.baselineIdleClipId,
          elapsed,
          caseIdleIntensityRef.current,
          speechLevelRef.current,
          idleRandomControllerRef.current.update(elapsed, delta),
        );
        const residualReactionPulse = Math.max(
          performanceState.reactionWeight,
          performanceState.releaseProgress < 1 ? (1 - performanceState.releaseProgress) * 0.28 : 0,
        );
        const blendedPose = motionControllerRef.current.update(
          activeCue,
          activeIntensity,
          residualReactionPulse,
          elapsed,
          delta,
          transitionMsRef.current,
          holdMsRef.current,
          priorityRef.current,
        );
        const idleBlendedPose = addIdleToBlendedPose(blendedPose, idlePulse);
        const proceduralReactionPose = performanceState.activeReactionClipId
          ? proceduralClipPose(
            performanceState.activeReactionClipId,
            activeCue,
            performanceState.localReactionTime + performanceState.phaseOffset,
            activeIntensity * performanceState.motionScale,
            residualReactionPulse,
            performanceState.selectedVariant,
            performanceState.mirror,
          )
          : undefined;
        const finalPose = proceduralReactionPose
          ? blendBlendedPose(idleBlendedPose, proceduralReactionPose, performanceState.reactionWeight)
          : idleBlendedPose;
        const upperBodyAnimationActive = policyActionActiveRef.current || manualVrmaActiveRef.current;
        if (ENABLE_SEATED_BONE_RUNTIME && seatedRuntimeAvailableRef.current) {
          const isConservativeRig = vrmRef.current.scene.userData.rigProfile === 'vrm0Conservative';
          if (wasUpperBodyAnimationActiveRef.current && !upperBodyAnimationActive) {
            safePoseRuntimeRef.current.captureFromVrm(vrmRef.current, true);
          }
          try {
            const targetPose = buildSeatedPose(
              vrmRef.current,
              activeCue,
              activeIntensity,
              residualReactionPulse,
              elapsed,
              !upperBodyAnimationActive,
              finalPose,
              isConservativeRig,
            );
            safePoseRuntimeRef.current.apply(vrmRef.current, targetPose, delta, {
              upperBody: !upperBodyAnimationActive,
              lowerBody: true,
              conservativeRig: isConservativeRig,
            });
            if (!validateVisibleAvatarBounds(vrmRef.current.scene)) {
              throw new Error('runtime produced invalid avatar bounds');
            }
          } catch (error) {
            seatedRuntimeAvailableRef.current = false;
            const fallbackPose = buildSeatedPose(
              vrmRef.current,
              'neutral',
              0.45,
              0,
              elapsed,
              true,
              undefined,
              isConservativeRig,
            );
            applySeatedPose(vrmRef.current, fallbackPose);
            safePoseRuntimeRef.current.reset(fallbackPose);
            publishVrmStageDebug({
              seatedRuntimeDisabled: true,
              seatedRuntimeError: error instanceof Error ? error.message : String(error),
            });
          }
        }
        wasUpperBodyAnimationActiveRef.current = upperBodyAnimationActive;
        updateGazeTarget(
          camera,
          gazeTarget,
          activeCue,
          activeIntensity,
          residualReactionPulse,
          elapsed,
          delta,
          transitionMsRef.current,
          caseGazePatternRef.current,
        );
      }
      applyExpressions(elapsed, expressionReactionPulse, delta);
      vrmRef.current?.update(delta);
      try {
        renderer.render(scene, camera);
      } catch (error) {
        setStageNotice(`Avatar 渲染失敗：${error instanceof Error ? error.message : String(error)}`);
        publishVrmStageDebug({
          avatarLoaded: Boolean(vrmRef.current),
          renderError: error instanceof Error ? error.message : String(error),
          tickCount,
        });
        return;
      }
      if (elapsed - lastDebugAt > 1) {
        lastDebugAt = elapsed;
        const size = new THREE.Vector2();
        renderer.getSize(size);
        const vrmBounds = vrmRef.current ? readableBounds(vrmRef.current.scene) : null;
        publishVrmStageDebug({
          avatarLoaded: Boolean(vrmRef.current),
          tickCount,
          elapsed,
          sceneChildren: scene.children.length,
          vrmChildren: vrmRef.current?.scene.children.length ?? 0,
          rendererWidth: size.x,
          rendererHeight: size.y,
          cameraPosition: camera.position.toArray(),
          cameraTarget: controls.target.toArray(),
          vrmBounds,
          stagePath: avatarPath,
        });
      }
      frameId = requestAnimationFrame(tick);
    };

    resize();
    requestAnimationFrame(resize);
    tick();
    resizeObserver.observe(containerRef.current.parentElement ?? containerRef.current);
    window.addEventListener('resize', resize);

    return () => {
      disposed = true;
      cancelAnimationFrame(frameId);
      resizeObserver.disconnect();
      window.removeEventListener('resize', resize);
      controls.dispose();
      renderer.dispose();
      renderer.domElement.remove();
      actionRef.current = null;
      vrmRef.current = null;
      mixerRef.current = null;
    };
  }, [avatarFallbackKey, avatarFallbackPaths, avatarLabel, avatarPath, onStatusChange]);

  useEffect(() => {
    if (!vrmaFile || !vrmRef.current) return;

    let active = true;
    const selectedFile = vrmaFile;

    async function loadVrma() {
      const vrm = vrmRef.current;
      if (!vrm) return;

      try {
        const buffer = await selectedFile.arrayBuffer();
        const loader = new GLTFLoader();
        loader.register((parser) => new VRMAnimationLoaderPlugin(parser));
        const gltf = await loader.parseAsync(buffer, '');
        const animations = gltf.userData.vrmAnimations as VRMAnimation[] | undefined;
        const vrmAnimation = animations?.[0];
        if (!vrmAnimation) {
          throw new Error('No VRM animation found in the selected .vrma file.');
        }

        const clip = maskUpperBodyClip(createVRMAnimationClip(vrmAnimation, vrm), selectedFile.name);
        const mixer = mixerRef.current ?? new THREE.AnimationMixer(vrm.scene);
        const action = mixer.clipAction(clip);
        actionRef.current?.fadeOut(0.45);
        action.reset().setEffectiveWeight(1).fadeIn(0.45).play();
        if (!active) return;
        mixerRef.current = mixer;
        actionRef.current = action;
        manualVrmaActiveRef.current = true;
        onStatusChange({
          avatarLoaded: true,
          vrmaLoaded: true,
          message: `Loaded VRMA motion: ${selectedFile.name}`,
        });
      } catch (error) {
        onStatusChange({
          avatarLoaded: true,
          vrmaLoaded: false,
          message: `Failed to load VRMA: ${error instanceof Error ? error.message : String(error)}`,
        });
      }
    }

    loadVrma();

    return () => {
      active = false;
      manualVrmaActiveRef.current = false;
    };
  }, [vrmaFile, onStatusChange]);

  useEffect(() => {
    if (vrmaFile || !performancePlan || !vrmRef.current) return;
    const plan = performancePlan;
    const clipId = plan.reactionClipId ?? plan.baselineClipId;
    if (!clipId || plan.clipSource !== 'vrma') return;
    if (activeReactionInstanceRef.current === plan.reactionInstanceId) return;
    activeReactionInstanceRef.current = plan.reactionInstanceId;

    let active = true;
    let releaseTimer: number | undefined;
    let stopTimer: number | undefined;

    async function loadPolicyClip() {
      const vrm = vrmRef.current;
      if (!vrm) return;
      if (vrm.scene.userData.rigProfile === 'vrm0Conservative') {
        policyActionActiveRef.current = false;
        return;
      }
      try {
        const manifest = clipManifestRef.current ?? (await fetchAvatarClipManifest());
        clipManifestRef.current = manifest;
        const clipEntry = manifest.clips.find(
          (entry) =>
            entry.id === clipId &&
            entry.autoLoad &&
            entry.playbackMask === 'upper_body' &&
            entry.seatedRuntime,
        );
        if (!clipEntry) return;

        const loader = new GLTFLoader();
        loader.register((parser) => new VRMAnimationLoaderPlugin(parser));
        const gltf = await loader.loadAsync(clipEntry.file);
        const animations = gltf.userData.vrmAnimations as VRMAnimation[] | undefined;
        const vrmAnimation = animations?.[0];
        if (!vrmAnimation) throw new Error(`No VRM animation found in ${clipEntry.id}.`);

        const clip = maskUpperBodyClip(createVRMAnimationClip(vrmAnimation, vrm), clipEntry.id);
        if (clip.tracks.length === 0) throw new Error(`Upper-body mask removed all tracks from ${clipEntry.id}.`);
        if (!active) return;
        const mixer = mixerRef.current ?? new THREE.AnimationMixer(vrm.scene);
        const action = mixer.clipAction(clip);
        const fadeSeconds = Math.max(0.2, plan.crossfadeMs / 1000);
        const releaseSeconds = Math.max(0.2, plan.releaseMs / 1000);
        const jitter = reactionClipJitter(clip.duration);
        policyActionRef.current?.fadeOut(fadeSeconds);
        action
          .reset()
          .setLoop(THREE.LoopOnce, 1)
          .setEffectiveWeight(Math.max(0.22, Math.min(plan.motionScale * jitter.weight, 0.9)))
          .fadeIn(fadeSeconds)
          .play();
        action.timeScale = jitter.timeScale;
        action.time = jitter.startOffset;
        action.clampWhenFinished = false;
        mixerRef.current = mixer;
        policyActionRef.current = action;
        policyActionActiveRef.current = true;
        releaseTimer = window.setTimeout(() => {
          action.fadeOut(releaseSeconds);
          stopTimer = window.setTimeout(() => {
            action.stop();
            if (policyActionRef.current === action) {
              policyActionRef.current = null;
              policyActionActiveRef.current = false;
            }
          }, plan.releaseMs + 80);
        }, Math.max(250, plan.reactionDurationMs));
        onStatusChange({
          avatarLoaded: true,
          vrmaLoaded: true,
          message: `Loaded upper-body VRMA clip: ${clipEntry.id}`,
        });
      } catch (error) {
        policyActionActiveRef.current = false;
        if (activeReactionInstanceRef.current === plan.reactionInstanceId) {
          activeReactionInstanceRef.current = null;
        }
        onStatusChange({
          avatarLoaded: true,
          vrmaLoaded: false,
          message: `VRMA clip fallback to procedural seated motion: ${error instanceof Error ? error.message : String(error)}`,
        });
      }
    }

    loadPolicyClip();

    return () => {
      active = false;
      if (releaseTimer) window.clearTimeout(releaseTimer);
      if (stopTimer) window.clearTimeout(stopTimer);
    };
  }, [performancePlan, reactionKey, vrmaFile, onStatusChange]);

  return (
    <div className="stage" aria-label="VRM avatar preview">
      <div className="stageCanvasHost" ref={containerRef} />
      {stageNotice ? <div className="stageNotice">{stageNotice}</div> : null}
    </div>
  );
}

type PoseLayer = ReturnType<typeof cuePose>;
type ArmLayer = ReturnType<typeof handPose>;
type BlendedPose = {
  pose: PoseLayer;
  armPose: ArmLayer;
};
type ProceduralClipCategory = 'idle' | 'reaction' | 'bridge' | 'speech';
type ReactionFamily = NonNullable<AvatarPerformancePlan['reactionFamily']>;
type ReleaseCurve = NonNullable<AvatarPerformancePlan['releaseCurve']>;
type ProceduralClip = {
  id: string;
  category: ProceduralClipCategory;
  family?: ReactionFamily;
  motionCue: MotionCue;
  durationMs: number;
  attackMs: number;
  holdMs: number;
  releaseMs: number;
  motionScale: number;
  bones: string[];
  gaze: AvatarGazePattern;
  expressionHints: AffectLabel[];
  allowedCases: string[];
  riskSafe: boolean;
  mirrorable: boolean;
  variants: string[];
  releaseCurve: ReleaseCurve;
};

type AvatarPerformanceState = {
  baselineIdleClipId: string;
  reactionProgress: number;
  releaseProgress: number;
  bridgeProgress: number;
  reactionWeight: number;
  localReactionTime: number;
  attackWeight: number;
  holdWeight: number;
  releaseWeight: number;
  bridgeWeight: number;
  activeReactionClipId?: string;
  selectedVariant?: string;
  recentClipIds: string[];
  mirror: boolean;
  phaseOffset: number;
  motionScale: number;
};

function createAvatarPerformanceController() {
  let lastReactionKey = '';
  let reactionStartedAt = 0;
  let reactionDuration = 2.2;
  let releaseDuration = 0.7;
  let returnBridgeDuration = 0.7;
  let attackDuration = 0.28;
  let selected: {
    clip: ProceduralClip;
    variant: string;
    mirror: boolean;
    phaseOffset: number;
    motionScale: number;
    releaseCurve: ReleaseCurve;
  } | null = null;
  const recentClipIds: string[] = [];

  return {
    update(
      plan: AvatarPerformancePlan | undefined,
      reactionKey: string,
      elapsed: number,
    ): AvatarPerformanceState {
      if (reactionKey && reactionKey !== lastReactionKey) {
        lastReactionKey = reactionKey;
        reactionStartedAt = elapsed;
        reactionDuration = Math.max(0.4, (plan?.reactionDurationMs ?? 2200) / 1000);
        releaseDuration = Math.max(0.2, (plan?.releaseMs ?? 700) / 1000);
        returnBridgeDuration = Math.max(0.25, (plan?.returnBridgeMs ?? 700) / 1000);
        attackDuration = Math.max(0.12, (plan?.attackMs ?? 280) / 1000);
        selected = selectProceduralReactionClip(plan, recentClipIds);
        if (selected) {
          recentClipIds.unshift(selected.clip.id);
          recentClipIds.splice(5);
        }
      }
      const age = reactionStartedAt > 0 ? elapsed - reactionStartedAt : Number.POSITIVE_INFINITY;
      const attackProgress = smoothstep(age / attackDuration);
      const reactionProgress = age < reactionDuration ? smoothstep(age / reactionDuration) : 1;
      const releaseAge = Math.max(0, age - reactionDuration);
      const releaseProgress = releaseAge < releaseDuration ? smoothstep(releaseAge / releaseDuration) : 1;
      const bridgeAge = Math.max(0, releaseAge - releaseDuration);
      const bridgeProgress = bridgeAge < returnBridgeDuration ? smoothstep(bridgeAge / returnBridgeDuration) : 1;
      const releaseWeight = releaseProgress < 1 ? 1 - releaseProgress : 0;
      const bridgeWeight = releaseProgress >= 1 && bridgeProgress < 1
        ? bridgeResidualWeight(selected?.releaseCurve ?? plan?.releaseCurve ?? 'soft') * (1 - bridgeProgress)
        : 0;
      const holdWeight = age < reactionDuration ? attackProgress : 0;
      const reactionWeight = selected ? Math.max(0, Math.min(1, holdWeight + releaseWeight + bridgeWeight)) : 0;
      return {
        baselineIdleClipId: plan?.baselineIdleClipId ?? 'idle_neutral_breathing',
        reactionProgress,
        releaseProgress,
        bridgeProgress,
        reactionWeight,
        localReactionTime: Number.isFinite(age) ? Math.max(0, age) : 0,
        attackWeight: selected && age < attackDuration ? attackProgress : 0,
        holdWeight: selected && age < reactionDuration ? holdWeight : 0,
        releaseWeight: selected ? releaseWeight : 0,
        bridgeWeight: selected ? bridgeWeight : 0,
        activeReactionClipId: reactionWeight > 0.001 ? selected?.clip.id : undefined,
        selectedVariant: reactionWeight > 0.001 ? selected?.variant : undefined,
        recentClipIds: [...recentClipIds],
        mirror: selected?.mirror ?? false,
        phaseOffset: selected?.phaseOffset ?? 0,
        motionScale: selected?.motionScale ?? 1,
      };
    },
  };
}

const PROCEDURAL_SEATED_CLIPS: Record<string, ProceduralClip> = {
  idle_neutral_breathing: seatedClip('idle_neutral_breathing', 'idle', undefined, 'neutral', 2800, 'camera_soft', ['neutral'], true, false),
  idle_guarded_lean_back: seatedClip('idle_guarded_lean_back', 'idle', 'defensive', 'lean_back', 3200, 'guarded', ['defensive'], true, false),
  idle_withdrawn_downward: seatedClip('idle_withdrawn_downward', 'idle', 'withdrawn', 'look_down', 3600, 'downward', ['withdrawn', 'sad'], true, false),
  idle_anxious_micro_fidget: seatedClip('idle_anxious_micro_fidget', 'idle', 'anxious', 'rub_hands', 2600, 'scanning', ['anxious'], true, true),
  idle_ashamed_low_head: seatedClip('idle_ashamed_low_head', 'idle', 'ashamed', 'look_down', 3800, 'downward', ['ashamed'], true, true),
  idle_low_energy_sleepy: seatedClip('idle_low_energy_sleepy', 'idle', 'withdrawn', 'look_down', 4200, 'downward', ['sad', 'withdrawn'], true, false),
  reaction_mocked_recoil_small: seatedClip('reaction_mocked_recoil_small', 'reaction', 'defensive', 'lean_back', 1700, 'guarded', ['defensive', 'irritated'], false, true, 0.72, 'guarded'),
  reaction_mocked_recoil_side: seatedClip('reaction_mocked_recoil_side', 'reaction', 'defensive', 'lean_back', 1850, 'guarded', ['defensive', 'irritated'], false, true, 0.66, 'guarded'),
  reaction_judgment_guard_hands: seatedClip('reaction_judgment_guard_hands', 'reaction', 'defensive', 'lean_back', 2100, 'guarded', ['defensive'], false, true, 0.58, 'guarded'),
  reaction_apology_guarded_avoid: seatedClip('reaction_apology_guarded_avoid', 'reaction', 'defensive', 'avoid_eye_contact', 2200, 'avoidant', ['defensive', 'withdrawn'], true, true, 0.5, 'guarded'),
  reaction_shame_drop_gaze: seatedClip('reaction_shame_drop_gaze', 'reaction', 'ashamed', 'look_down', 2500, 'downward', ['ashamed', 'sad'], true, true, 0.55, 'low_energy'),
  reaction_shame_hand_press: seatedClip('reaction_shame_hand_press', 'reaction', 'ashamed', 'look_down', 2800, 'downward', ['ashamed', 'withdrawn'], true, true, 0.46, 'low_energy'),
  reaction_anxiety_micro_rub: seatedClip('reaction_anxiety_micro_rub', 'reaction', 'anxious', 'rub_hands', 2300, 'scanning', ['anxious'], false, true, 0.48, 'soft'),
  reaction_anxiety_finger_fidget: seatedClip('reaction_anxiety_finger_fidget', 'reaction', 'anxious', 'rub_hands', 2500, 'scanning', ['anxious'], true, true, 0.38, 'soft'),
  reaction_reflective_single_nod: seatedClip('reaction_reflective_single_nod', 'reaction', 'reflective', 'slow_nod', 2100, 'camera_soft', ['reflective'], true, true, 0.42, 'soft'),
  reaction_reflective_double_micro_nod: seatedClip('reaction_reflective_double_micro_nod', 'reaction', 'reflective', 'slow_nod', 2600, 'camera_soft', ['reflective'], true, true, 0.36, 'soft'),
  reaction_risk_low_intensity_downward: seatedClip('reaction_risk_low_intensity_downward', 'reaction', 'risk', 'look_down', 3000, 'downward', ['sad', 'withdrawn'], true, false, 0.32, 'low_energy'),
  reaction_withdrawn_short_answer: seatedClip('reaction_withdrawn_short_answer', 'reaction', 'withdrawn', 'look_down', 2000, 'avoidant', ['withdrawn'], true, true, 0.42, 'low_energy'),
  reaction_irritated_head_turn: seatedClip('reaction_irritated_head_turn', 'reaction', 'defensive', 'avoid_eye_contact', 1800, 'guarded', ['irritated', 'defensive'], false, true, 0.5, 'guarded'),
  reaction_soft_engagement_forward: seatedClip('reaction_soft_engagement_forward', 'reaction', 'soft_engagement', 'slow_nod', 2200, 'camera_soft', ['reflective', 'neutral'], true, true, 0.34, 'soft'),
};

function seatedClip(
  id: string,
  category: ProceduralClipCategory,
  family: ReactionFamily | undefined,
  motionCue: MotionCue,
  durationMs: number,
  gaze: AvatarGazePattern,
  expressionHints: AffectLabel[],
  riskSafe: boolean,
  mirrorable: boolean,
  motionScale = 0.42,
  releaseCurve: ReleaseCurve = 'soft',
): ProceduralClip {
  return {
    id,
    category,
    family,
    motionCue,
    durationMs,
    attackMs: category === 'idle' ? 900 : releaseCurve === 'guarded' ? 220 : 360,
    holdMs: Math.max(400, durationMs - 900),
    releaseMs: releaseCurve === 'low_energy' ? 950 : 700,
    motionScale,
    bones: ['spine', 'chest', 'neck', 'head', 'shoulder', 'upperArm', 'lowerArm', 'hand'],
    gaze,
    expressionHints,
    allowedCases: [],
    riskSafe,
    mirrorable,
    variants: ['a', 'b', 'c'],
    releaseCurve,
  };
}

function selectProceduralReactionClip(plan: AvatarPerformancePlan | undefined, recentClipIds: string[]) {
  const family = plan?.reactionFamily ?? familyForClipId(plan?.reactionClipId) ?? 'soft_engagement';
  const preferred = [
    ...(plan?.preferredClipIds ?? []),
    ...(plan?.reactionClipId ? [plan.reactionClipId] : []),
    ...clipsForFamily(family),
  ].filter((id) => PROCEDURAL_SEATED_CLIPS[id]?.category === 'reaction');
  const uniquePreferred = [...new Set(preferred)];
  if (!uniquePreferred.length) return null;
  const excluded = new Set([...(plan?.excludedRecentClipIds ?? []), ...recentClipIds.slice(0, 3)]);
  const candidates = uniquePreferred.filter((id) => plan?.variantPolicy !== 'avoid_recent' || !excluded.has(id));
  const pool = candidates.length ? candidates : uniquePreferred;
  const clip = PROCEDURAL_SEATED_CLIPS[pool[Math.floor(Math.random() * pool.length)]];
  if (!clip) return null;
  return {
    clip,
    variant: clip.variants[Math.floor(Math.random() * clip.variants.length)] ?? 'a',
    mirror: clip.mirrorable && Math.random() > 0.5,
    phaseOffset: randomRange(0, Math.PI * 2),
    motionScale: Math.max(0.22, Math.min(0.95, (plan?.motionScale ?? 0.7) * randomRange(0.86, 1.08) * clip.motionScale)),
    releaseCurve: plan?.releaseCurve ?? clip.releaseCurve,
  };
}

function clipsForFamily(family: ReactionFamily) {
  return Object.values(PROCEDURAL_SEATED_CLIPS)
    .filter((clip) => clip.category === 'reaction' && clip.family === family)
    .map((clip) => clip.id);
}

function familyForClipId(clipId?: string): ReactionFamily | undefined {
  if (!clipId) return undefined;
  return PROCEDURAL_SEATED_CLIPS[clipId]?.family;
}

function bridgeResidualWeight(curve: ReleaseCurve) {
  if (curve === 'guarded') return 0.32;
  if (curve === 'low_energy') return 0.24;
  return 0.18;
}

type IdleRandomState = {
  spineY: number;
  chestY: number;
  neckX: number;
  neckY: number;
  headX: number;
  headY: number;
  armX: number;
  forearmX: number;
  handY: number;
};

function createIdleRandomController() {
  let nextChangeAt = 0;
  let current = zeroIdleRandom();
  let target = zeroIdleRandom();

  return {
    update(elapsed: number, delta: number): IdleRandomState {
      if (elapsed >= nextChangeAt) {
        target = {
          spineY: randomRange(-0.012, 0.012),
          chestY: randomRange(-0.016, 0.016),
          neckX: randomRange(-0.012, 0.014),
          neckY: randomRange(-0.022, 0.022),
          headX: randomRange(-0.016, 0.018),
          headY: randomRange(-0.028, 0.028),
          armX: randomRange(-0.012, 0.014),
          forearmX: randomRange(-0.018, 0.018),
          handY: randomRange(-0.026, 0.026),
        };
        nextChangeAt = elapsed + randomRange(2.8, 5.8);
      }
      current = dampRecord(current, target, dampAlpha(delta, 1.35));
      return current;
    },
  };
}

function zeroIdleRandom(): IdleRandomState {
  return {
    spineY: 0,
    chestY: 0,
    neckX: 0,
    neckY: 0,
    headX: 0,
    headY: 0,
    armX: 0,
    forearmX: 0,
    handY: 0,
  };
}

function randomRange(min: number, max: number) {
  return min + Math.random() * (max - min);
}

function reactionClipJitter(duration: number) {
  const safeDuration = Number.isFinite(duration) ? Math.max(0, duration) : 0;
  return {
    timeScale: randomRange(0.94, 1.08),
    weight: randomRange(0.92, 1.04),
    startOffset: safeDuration > 0.75 ? randomRange(0, Math.min(0.18, safeDuration * 0.08)) : 0,
  };
}

function baselineIdlePulse(
  clipId: string,
  elapsed: number,
  idleIntensity: number,
  speechLevel: number,
  randomState: IdleRandomState,
): BlendedPose {
  const intensity = Math.min(1, Math.max(0.15, idleIntensity));
  const breath = Math.sin(elapsed * 1.35) * 0.018 * intensity;
  const slow = Math.sin(elapsed * 0.47) * 0.014 * intensity;
  const fidget = Math.sin(elapsed * 3.1) * 0.02 * intensity;
  const speech = Math.min(1, Math.max(0, speechLevel)) * 0.035;
  const randomScale = intensity * 0.75;
  const guarded = clipId.includes('defensive') || clipId.includes('guarded');
  const withdrawn = clipId.includes('withdrawn') || clipId.includes('ashamed');
  const anxious = clipId.includes('anxious');
  const reflective = clipId.includes('reflective');

  return {
    pose: {
      hipX: guarded ? -0.015 : 0,
      hipY: 0,
      hipZ: guarded ? -0.012 : 0,
      spineX: breath + (guarded ? -0.035 : withdrawn ? 0.032 : reflective ? 0.018 : 0),
      spineY: slow * 0.4 + randomState.spineY * randomScale,
      chestX: breath + (guarded ? -0.05 : withdrawn ? 0.04 : reflective ? 0.025 : 0),
      chestY: slow + randomState.chestY * randomScale,
      chestZ: 0,
      neckX: (withdrawn ? -0.035 : speech) + randomState.neckX * randomScale,
      neckY: (anxious ? slow * 2.2 : slow) + randomState.neckY * randomScale,
      headX: (withdrawn ? -0.055 : speech + Math.sin(elapsed * 0.62) * 0.012) + randomState.headX * randomScale,
      headY: (anxious ? Math.sin(elapsed * 0.85) * 0.05 : slow * 1.2) + randomState.headY * randomScale,
      headZ: guarded ? -0.01 : 0,
      armX: (anxious ? 0.025 + fidget : 0) + randomState.armX * randomScale,
      forearmX: (anxious ? 0.04 + fidget : 0) + randomState.forearmX * randomScale,
      leftArmY: anxious ? fidget : 0,
      rightArmY: anxious ? -fidget : 0,
      leftArmZ: 0,
      rightArmZ: 0,
    },
    armPose: {
      upperArmX: anxious ? fidget * 0.35 : 0,
      leftUpperArmY: anxious ? fidget * 0.25 : 0,
      rightUpperArmY: anxious ? -fidget * 0.25 : 0,
      leftUpperArmZ: 0,
      rightUpperArmZ: 0,
      leftLowerArmX: anxious ? fidget * 0.45 : 0,
      rightLowerArmX: anxious ? -fidget * 0.45 : 0,
      leftLowerArmY: anxious ? -fidget * 0.5 : 0,
      rightLowerArmY: anxious ? fidget * 0.5 : 0,
      leftLowerArmZ: 0,
      rightLowerArmZ: 0,
      handX: 0,
      leftHandY: (anxious ? -fidget : 0) - randomState.handY * randomScale,
      rightHandY: (anxious ? fidget : 0) + randomState.handY * randomScale,
      leftHandZ: 0,
      rightHandZ: 0,
    },
  };
}

function addIdleToBlendedPose(base: BlendedPose, idle: BlendedPose): BlendedPose {
  return {
    pose: addRecord(base.pose, idle.pose),
    armPose: addRecord(base.armPose, idle.armPose),
  };
}

function proceduralClipPose(
  clipId: string,
  fallbackCue: MotionCue,
  elapsed: number,
  motionIntensity: number,
  reactionPulse: number,
  variant = 'a',
  mirror = false,
): BlendedPose {
  const clip = PROCEDURAL_SEATED_CLIPS[clipId];
  const cue = clip?.motionCue ?? fallbackCue;
  const phase = elapsed + (variant === 'b' ? 0.8 : variant === 'c' ? 1.6 : 0);
  const intensity = clampMotionIntensity(motionIntensity);
  const pose = cuePose(cue, phase, intensity, reactionPulse);
  const armPose = handPose(cue, phase, intensity, reactionPulse, pose);
  const soft = Math.sin(phase * 1.2) * 0.018 * intensity;
  const quick = Math.sin(phase * 4.4) * 0.026 * intensity;

  if (clipId === 'reaction_mocked_recoil_small') {
    pose.chestX -= 0.07 * intensity;
    pose.headY -= 0.08 * intensity;
    pose.headZ -= 0.03 * intensity;
    armPose.leftLowerArmX += 0.08 * intensity;
    armPose.rightLowerArmX += 0.08 * intensity;
  } else if (clipId === 'reaction_mocked_recoil_side') {
    pose.chestX -= 0.055 * intensity;
    pose.chestY += 0.08 * intensity;
    pose.neckY += 0.14 * intensity;
    pose.headY += 0.2 * intensity;
    pose.headZ -= 0.035 * intensity;
  } else if (clipId === 'reaction_judgment_guard_hands') {
    pose.chestX -= 0.04 * intensity;
    pose.headY -= 0.06 * intensity;
    armPose.leftUpperArmZ += 0.18 * intensity;
    armPose.rightUpperArmZ -= 0.18 * intensity;
    armPose.leftLowerArmX += 0.18 * intensity;
    armPose.rightLowerArmX += 0.18 * intensity;
  } else if (clipId === 'reaction_apology_guarded_avoid') {
    pose.headY += 0.18 * intensity;
    pose.headX -= 0.05 * intensity;
    armPose.leftHandY -= 0.08 * intensity;
    armPose.rightHandY += 0.08 * intensity;
  } else if (clipId === 'reaction_shame_drop_gaze') {
    pose.neckX -= 0.08 * intensity;
    pose.headX -= 0.16 * intensity;
    pose.chestX += 0.04 * intensity;
    armPose.leftLowerArmX += 0.1 * intensity;
    armPose.rightLowerArmX += 0.1 * intensity;
  } else if (clipId === 'reaction_shame_hand_press') {
    pose.headX -= 0.12 * intensity;
    pose.chestX += 0.035 * intensity;
    armPose.leftLowerArmY -= 0.16 * intensity;
    armPose.rightLowerArmY += 0.16 * intensity;
    armPose.leftHandY -= 0.16 * intensity;
    armPose.rightHandY += 0.16 * intensity;
  } else if (clipId === 'reaction_anxiety_micro_rub') {
    pose.headX -= 0.04 * intensity;
    armPose.leftLowerArmX += quick;
    armPose.rightLowerArmX -= quick;
    armPose.leftHandY -= quick * 1.8;
    armPose.rightHandY += quick * 1.8;
  } else if (clipId === 'reaction_anxiety_finger_fidget') {
    pose.neckY += soft * 1.5;
    armPose.leftHandY -= quick;
    armPose.rightHandY += quick;
    armPose.leftHandZ += soft;
    armPose.rightHandZ -= soft;
  } else if (clipId === 'reaction_reflective_single_nod') {
    const nod = Math.sin(Math.min(Math.PI, (phase % 1.4) * Math.PI));
    pose.headX += nod * 0.08 * intensity;
    pose.chestX += 0.02 * intensity;
  } else if (clipId === 'reaction_reflective_double_micro_nod') {
    const nod = Math.sin(phase * 5.1) * 0.045 * intensity;
    pose.headX += nod;
    pose.neckX += nod * 0.35;
  } else if (clipId === 'reaction_risk_low_intensity_downward') {
    pose.chestX += 0.03 * intensity;
    pose.neckX -= 0.08 * intensity;
    pose.headX -= 0.14 * intensity;
    armPose.leftLowerArmX += 0.08 * intensity;
    armPose.rightLowerArmX += 0.08 * intensity;
  } else if (clipId === 'reaction_withdrawn_short_answer') {
    pose.headY += 0.08 * intensity;
    pose.headX -= 0.08 * intensity;
    armPose.leftLowerArmX += 0.06 * intensity;
    armPose.rightLowerArmX += 0.06 * intensity;
  } else if (clipId === 'reaction_irritated_head_turn') {
    pose.neckY -= 0.18 * intensity;
    pose.headY -= 0.26 * intensity;
    pose.headZ -= 0.035 * intensity;
    pose.chestY -= 0.04 * intensity;
  } else if (clipId === 'reaction_soft_engagement_forward') {
    pose.chestX += 0.04 * intensity;
    pose.headX += 0.035 * intensity;
    armPose.leftLowerArmX += 0.04 * intensity;
    armPose.rightLowerArmX += 0.04 * intensity;
  }

  const next = { pose, armPose };
  return mirror ? mirrorBlendedPose(next) : next;
}

function blendBlendedPose(base: BlendedPose, target: BlendedPose, weight: number): BlendedPose {
  const w = Math.min(1, Math.max(0, weight));
  return {
    pose: blendRecord(base.pose, target.pose, w),
    armPose: blendRecord(base.armPose, target.armPose, w),
  };
}

function blendRecord<T extends Record<string, number>>(base: T, target: T, weight: number): T {
  const next = { ...base };
  Object.keys(target).forEach((key) => {
    next[key as keyof T] = (base[key as keyof T] + (target[key as keyof T] - base[key as keyof T]) * weight) as T[keyof T];
  });
  return next;
}

function mirrorBlendedPose(source: BlendedPose): BlendedPose {
  return {
    pose: {
      ...source.pose,
      spineY: -source.pose.spineY,
      chestY: -source.pose.chestY,
      neckY: -source.pose.neckY,
      headY: -source.pose.headY,
      leftArmY: -source.pose.rightArmY,
      rightArmY: -source.pose.leftArmY,
      leftArmZ: -source.pose.rightArmZ,
      rightArmZ: -source.pose.leftArmZ,
    },
    armPose: {
      ...source.armPose,
      leftUpperArmY: -source.armPose.rightUpperArmY,
      rightUpperArmY: -source.armPose.leftUpperArmY,
      leftUpperArmZ: -source.armPose.rightUpperArmZ,
      rightUpperArmZ: -source.armPose.leftUpperArmZ,
      leftLowerArmY: -source.armPose.rightLowerArmY,
      rightLowerArmY: -source.armPose.leftLowerArmY,
      leftLowerArmZ: -source.armPose.rightLowerArmZ,
      rightLowerArmZ: -source.armPose.leftLowerArmZ,
      leftHandY: -source.armPose.rightHandY,
      rightHandY: -source.armPose.leftHandY,
      leftHandZ: -source.armPose.rightHandZ,
      rightHandZ: -source.armPose.leftHandZ,
    },
  };
}

function addRecord<T extends Record<string, number>>(base: T, add: T): T {
  const next = { ...base };
  Object.keys(add).forEach((key) => {
    next[key as keyof T] = (base[key as keyof T] + add[key as keyof T]) as T[keyof T];
  });
  return next;
}

async function fetchAvatarClipManifest(): Promise<AvatarClipManifest> {
  const response = await fetch('/avatar-clips/manifest.json');
  if (!response.ok) throw new Error(`Failed to load avatar clip manifest: HTTP ${response.status}`);
  const manifest = await response.json();
  if (!isAvatarClipManifest(manifest)) throw new Error('Avatar clip manifest failed schema validation.');
  return manifest;
}

function isAvatarClipManifest(value: unknown): value is AvatarClipManifest {
  const manifest = value as AvatarClipManifest;
  return Array.isArray(manifest?.clips) && manifest.clips.every((clip) =>
    typeof clip.id === 'string' &&
    typeof clip.file === 'string' &&
    clip.playbackMask === 'upper_body' &&
    typeof clip.seatedRuntime === 'boolean' &&
    typeof clip.autoLoad === 'boolean',
  );
}

function maskUpperBodyClip(clip: THREE.AnimationClip, label: string) {
  const tracks = clip.tracks.filter((track) => isUpperBodyTrack(track.name));
  return new THREE.AnimationClip(`${label}_upper_body`, clip.duration, tracks);
}

function isUpperBodyTrack(trackName: string) {
  const name = trackName.toLowerCase();
  if (/(root|hips|upperleg|lowerleg|foot|toes|toe|leg)/.test(name)) return false;
  return /(spine|chest|neck|head|shoulder|upperarm|lowerarm|hand|lookat|expression|blendshape)/.test(name);
}

function createAvatarMotionController() {
  let currentPose: PoseLayer | null = null;
  let currentArmPose: ArmLayer | null = null;
  let lastCue: MotionCue = 'neutral';
  let gestureQueue: MotionCue[] = [];
  let poseTransition = { startedAt: 0, transitionMs: 700 };

  return {
    update(
      motionCue: MotionCue,
      motionIntensity: number,
      reactionPulse: number,
      elapsed: number,
      delta: number,
      transitionMs: number,
      holdMs: number,
      priority: AvatarDirectivePriority,
    ): BlendedPose {
      if (motionCue !== lastCue) {
        gestureQueue = [motionCue];
        lastCue = motionCue;
        poseTransition = { startedAt: elapsed, transitionMs };
      }
      const targetPose = cuePose(motionCue, elapsed, motionIntensity, reactionPulse);
      const targetArmPose = handPose(motionCue, elapsed, motionIntensity, reactionPulse, targetPose);
      if (!currentPose || !currentArmPose) {
        currentPose = { ...targetPose };
        currentArmPose = { ...targetArmPose };
        return { pose: currentPose, armPose: currentArmPose };
      }

      const effectiveMs = priority === 'safety' ? Math.max(transitionMs, 950) : transitionMs;
      const elapsedTransition = Math.max(0, elapsed - poseTransition.startedAt);
      const transitionProgress = smoothstep(Math.min(1, elapsedTransition / Math.max(effectiveMs / 1000, 0.001)));
      const timeConstant = Math.max(0.08, (effectiveMs / 1000) * (priority === 'reaction' ? 0.28 : 0.38));
      const alpha = Math.max(dampAlpha(delta, timeConstant), transitionProgress * 0.08);
      currentPose = dampRecord(currentPose, targetPose, alpha);
      currentArmPose = dampRecord(currentArmPose, targetArmPose, alpha);
      if (transitionProgress >= 1 && elapsedTransition > holdMs / 1000 && gestureQueue[0] === motionCue) {
        gestureQueue = [];
      }
      return { pose: currentPose, armPose: currentArmPose };
    },
  };
}

function clampExpression(value: unknown) {
  if (typeof value !== 'number' || Number.isNaN(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

type VrmExpressionManager = NonNullable<VRM['expressionManager']>;

const VRM_EXPRESSION_ALIASES: Record<string, string[]> = {
  happy: ['joy', 'fun'],
  sad: ['sorrow'],
  relaxed: ['fun'],
  surprised: ['Surprised'],
  aa: ['a'],
  ih: ['i'],
  ou: ['u'],
  ee: ['e'],
  oh: ['o'],
  blinkLeft: ['blink_l'],
  blinkRight: ['blink_r'],
};

function expressionAliases(name: string) {
  return [name, ...(VRM_EXPRESSION_ALIASES[name] ?? [])];
}

function setVrmExpressionValue(manager: VrmExpressionManager, name: string, value: number) {
  expressionAliases(name).forEach((alias) => {
    try {
      manager.setValue(alias, value);
    } catch {
      // Some VRM0/VRM1 assets only expose a subset of presets.
    }
  });
}

function getVrmExpressionValue(manager: VrmExpressionManager, name: string) {
  return expressionAliases(name).reduce((max, alias) => {
    try {
      return Math.max(max, manager.getValue(alias) ?? 0);
    } catch {
      return max;
    }
  }, 0);
}

function createMorphTargetExpressionController(scene: THREE.Object3D, modelPath: string) {
  const targets: Array<{
    mesh: THREE.Mesh;
    dictionary: Record<string, number>;
    influences: number[];
  }> = [];
  const current: Record<string, number> = {};
  const arkitNames = new Set<string>();

  scene.traverse((object) => {
    const mesh = object as THREE.Mesh & {
      morphTargetDictionary?: Record<string, number>;
      morphTargetInfluences?: number[];
    };
    if (!mesh.morphTargetDictionary || !mesh.morphTargetInfluences) return;
    const dictionary = mesh.morphTargetDictionary;
    Object.keys(dictionary).forEach((name) => {
      if (isArkitName(name)) arkitNames.add(name);
    });
    targets.push({
      mesh,
      dictionary,
      influences: mesh.morphTargetInfluences,
    });
  });

  return {
    modelPath,
    arkitTargetCount: arkitNames.size,
    apply(nextWeights: ArkitBlendshapeWeights, delta: number) {
      const names = new Set([...Object.keys(current), ...Object.keys(nextWeights)]);
      names.forEach((name) => {
        if (!isArkitName(name)) return;
        const target = clampExpression(nextWeights[name as ArkitBlendshapeName] ?? 0);
        const previous = clampExpression(current[name] ?? 0);
        const next = dampValue(previous, target, delta, expressionTimeConstant(name, target > previous));
        current[name] = next;
        targets.forEach(({ dictionary, influences }) => {
          const index = dictionary[name];
          if (typeof index === 'number') influences[index] = next;
        });
        if (next <= 0.002 && target === 0) delete current[name];
      });
    },
  };
}

function mergeArkitWeights(...layers: ArkitBlendshapeWeights[]): ArkitBlendshapeWeights {
  const merged: Record<string, number> = {};
  layers.forEach((layer) => {
    Object.entries(layer).forEach(([name, value]) => {
      merged[name] = Math.max(merged[name] ?? 0, clampExpression(value));
    });
  });
  return merged as ArkitBlendshapeWeights;
}

function arkitDebugSnapshot(
  modelPath: string,
  controller: ReturnType<typeof createMorphTargetExpressionController>,
  activeExpressionProfile: string,
  activeViseme: CantoneseViseme | 'none',
  activeVisemeChar: string,
  weights: ArkitBlendshapeWeights,
): AvatarBlendshapeDebug {
  return {
    modelPath,
    arkitAvailable: controller.arkitTargetCount >= 52,
    arkitTargetCount: controller.arkitTargetCount,
    activeExpressionProfile,
    activeViseme,
    activeVisemeChar,
    mouthWeight: maxWeight(weights, /^(jaw|mouth|tongue)/),
    browWeight: maxWeight(weights, /^brow/),
    eyeWeight: maxWeight(weights, /^(eye|cheek)/),
  };
}

function maxWeight(weights: ArkitBlendshapeWeights, pattern: RegExp) {
  return Object.entries(weights).reduce(
    (max, [name, value]) => (pattern.test(name) ? Math.max(max, clampExpression(value)) : max),
    0,
  );
}

function isArkitName(name: string): name is ArkitBlendshapeName {
  return ARKIT_NAME_SET.has(name as ArkitBlendshapeName);
}

function dampValue(current: number, target: number, delta: number, timeConstant: number) {
  return current + (target - current) * dampAlpha(delta, timeConstant);
}

function dampAlpha(delta: number, timeConstant: number) {
  return 1 - Math.exp(-Math.max(delta, 0) / Math.max(timeConstant, 0.001));
}

function dampRecord<T extends Record<string, number>>(current: T, target: T, alpha: number): T {
  const next = { ...current };
  Object.keys(target).forEach((key) => {
    next[key as keyof T] = (current[key as keyof T] + (target[key as keyof T] - current[key as keyof T]) * alpha) as T[keyof T];
  });
  return next;
}

function smoothstep(value: number) {
  const x = Math.min(1, Math.max(0, value));
  return x * x * (3 - 2 * x);
}

function expressionTimeConstant(name: string, attack: boolean) {
  if (name.startsWith('jaw') || name.startsWith('mouth')) return attack ? 0.045 : 0.09;
  if (name.startsWith('eyeBlink')) return attack ? 0.035 : 0.08;
  if (name.startsWith('eye') || name.startsWith('brow')) return attack ? 0.09 : 0.24;
  if (name === 'surprised') return attack ? 0.055 : 0.16;
  if (name === 'angry') return attack ? 0.07 : 0.34;
  if (name === 'sad') return attack ? 0.22 : 0.46;
  if (name === 'relaxed') return attack ? 0.18 : 0.28;
  if (name === 'neutral') return attack ? 0.2 : 0.24;
  return attack ? 0.12 : 0.28;
}

const ARKIT_NAME_SET = new Set<ArkitBlendshapeName>([
  'browDownLeft',
  'browDownRight',
  'browInnerUp',
  'browOuterUpLeft',
  'browOuterUpRight',
  'cheekPuff',
  'cheekSquintLeft',
  'cheekSquintRight',
  'eyeBlinkLeft',
  'eyeBlinkRight',
  'eyeLookDownLeft',
  'eyeLookDownRight',
  'eyeLookInLeft',
  'eyeLookInRight',
  'eyeLookOutLeft',
  'eyeLookOutRight',
  'eyeLookUpLeft',
  'eyeLookUpRight',
  'eyeSquintLeft',
  'eyeSquintRight',
  'eyeWideLeft',
  'eyeWideRight',
  'jawForward',
  'jawLeft',
  'jawOpen',
  'jawRight',
  'mouthClose',
  'mouthDimpleLeft',
  'mouthDimpleRight',
  'mouthFrownLeft',
  'mouthFrownRight',
  'mouthFunnel',
  'mouthLeft',
  'mouthLowerDownLeft',
  'mouthLowerDownRight',
  'mouthPressLeft',
  'mouthPressRight',
  'mouthPucker',
  'mouthRight',
  'mouthRollLower',
  'mouthRollUpper',
  'mouthShrugLower',
  'mouthShrugUpper',
  'mouthSmileLeft',
  'mouthSmileRight',
  'mouthStretchLeft',
  'mouthStretchRight',
  'mouthUpperUpLeft',
  'mouthUpperUpRight',
  'noseSneerLeft',
  'noseSneerRight',
  'tongueOut',
]);

function moodCueForBaseline(mood?: AffectLabel): MotionCue | undefined {
  if (mood === 'defensive' || mood === 'irritated') return 'lean_back';
  if (mood === 'withdrawn' || mood === 'sad' || mood === 'ashamed') return 'look_down';
  if (mood === 'anxious') return 'avoid_eye_contact';
  if (mood === 'reflective') return 'slow_nod';
  return undefined;
}

function activeMotionCue(
  gesture: MotionCue | undefined,
  responseBaselineMood: AffectLabel | undefined,
  responseMotionCue: MotionCue,
  caseRestingCue: MotionCue | undefined,
  caseBaselineMood: AffectLabel | undefined,
): MotionCue {
  if (gesture) return gesture;
  const responseCue = moodCueForBaseline(responseBaselineMood);
  if (responseCue) return responseCue;
  if (responseMotionCue !== 'neutral') return responseMotionCue;
  if (caseRestingCue) return caseRestingCue;
  return moodCueForBaseline(caseBaselineMood) ?? 'neutral';
}

function createSimpleChair() {
  const group = new THREE.Group();
  const material = new THREE.MeshStandardMaterial({
    color: 0xd8dde4,
    roughness: 0.72,
    metalness: 0,
  });
  const shadowMaterial = new THREE.MeshStandardMaterial({
    color: 0xc4ccd6,
    roughness: 0.84,
    metalness: 0,
  });

  const seat = new THREE.Mesh(new THREE.BoxGeometry(0.92, 0.09, 0.68), material);
  seat.position.set(0, 0.42, 0.04);
  seat.castShadow = true;
  seat.receiveShadow = true;
  group.add(seat);

  const back = new THREE.Mesh(new THREE.BoxGeometry(0.9, 0.64, 0.08), material);
  back.position.set(0, 0.76, -0.32);
  back.rotation.x = -0.08;
  back.castShadow = true;
  group.add(back);

  const legGeometry = new THREE.BoxGeometry(0.055, 0.42, 0.055);
  [
    [-0.36, 0.21, 0.28],
    [0.36, 0.21, 0.28],
    [-0.36, 0.21, -0.22],
    [0.36, 0.21, -0.22],
  ].forEach(([x, y, z]) => {
    const leg = new THREE.Mesh(legGeometry, shadowMaterial);
    leg.position.set(x, y, z);
    leg.castShadow = true;
    group.add(leg);
  });

  group.position.z = 0.02;
  return group;
}

function frameAvatarUpperBody(
  camera: THREE.PerspectiveCamera,
  controls: OrbitControls,
  gazeTarget: THREE.Object3D,
  avatarScene: THREE.Object3D,
) {
  avatarScene.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(avatarScene);
  const size = new THREE.Vector3();
  const center = new THREE.Vector3();
  box.getSize(size);
  box.getCenter(center);
  if (
    !Number.isFinite(size.x) ||
    !Number.isFinite(size.y) ||
    !Number.isFinite(size.z) ||
    size.y < 0.4
  ) {
    return false;
  }

  const upperBodyY = box.min.y + size.y * 0.8;
  const upperBodyHeight = Math.max(0.78, size.y * 0.5);
  const targetY = Math.min(1.62, Math.max(1.18, box.min.y + size.y * 0.76));
  const verticalFov = THREE.MathUtils.degToRad(camera.fov);
  const horizontalFov = 2 * Math.atan(Math.tan(verticalFov / 2) * Math.max(camera.aspect, 0.55));
  const distanceForWidth = (size.x * 0.86) / (2 * Math.tan(horizontalFov / 2));
  const distanceForHeight = upperBodyHeight / (2 * Math.tan(verticalFov / 2));
  const distance = Math.min(3.05, Math.max(1.78, distanceForWidth * 1.16, distanceForHeight * 1.04));
  const targetX = Math.abs(center.x) > 0.35 ? 0 : center.x;
  const targetZ = Math.abs(center.z) > 0.35 ? 0 : center.z;
  controls.target.set(targetX, targetY, targetZ);
  camera.position.set(targetX, targetY + 0.08, targetZ + distance);
  gazeTarget.position.set(targetX, Math.min(1.52, Math.max(1.16, upperBodyY)), targetZ + Math.min(1.1, distance * 0.72));
  camera.lookAt(controls.target);
  controls.update();
  publishVrmStageDebug({
    frameAvatar: {
      size: size.toArray(),
      center: center.toArray(),
      targetY,
      distance,
      distanceForWidth,
      distanceForHeight,
      cameraAspect: camera.aspect,
      cameraFov: camera.fov,
    },
  });
  return true;
}

function publishVrmStageDebug(snapshot: Record<string, unknown>) {
  const targetWindow = window as Window & {
    __vrmStageDebug?: Record<string, unknown>;
  };
  targetWindow.__vrmStageDebug = {
    ...(targetWindow.__vrmStageDebug ?? {}),
    ...snapshot,
    updatedAt: new Date().toISOString(),
  };
}

function readableBounds(object: THREE.Object3D) {
  object.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(object);
  const size = new THREE.Vector3();
  const center = new THREE.Vector3();
  box.getSize(size);
  box.getCenter(center);
  return {
    min: box.min.toArray(),
    max: box.max.toArray(),
    size: size.toArray(),
    center: center.toArray(),
  };
}

function validateVisibleAvatarBounds(object: THREE.Object3D) {
  object.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(object);
  const size = new THREE.Vector3();
  const center = new THREE.Vector3();
  box.getSize(size);
  box.getCenter(center);
  return (
    Number.isFinite(size.x) &&
    Number.isFinite(size.y) &&
    Number.isFinite(size.z) &&
    Number.isFinite(center.x) &&
    Number.isFinite(center.y) &&
    Number.isFinite(center.z) &&
    size.y >= 0.4 &&
    size.y <= 3.2 &&
    Math.abs(center.x) <= 1.4 &&
    center.y >= -0.4 &&
    center.y <= 2.4 &&
    Math.abs(center.z) <= 1.4
  );
}

function normalizeRenderableMesh(mesh: THREE.Mesh) {
  mesh.visible = true;
  mesh.frustumCulled = false;
  const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
  materials.forEach((material) => {
    if (!material) return;
    material.visible = true;
    material.colorWrite = true;
    if ('depthTest' in material) material.depthTest = true;
    if ('opacity' in material && typeof material.opacity === 'number' && material.opacity < 0.05) {
      material.opacity = 1;
      material.transparent = false;
    }
    material.needsUpdate = true;
  });
}

type NormalizedBonePose = {
  position?: [number, number, number];
  rotation?: [number, number, number, number];
};
type SeatedNormalizedPose = Partial<Record<VRMHumanBoneName, NormalizedBonePose>>;

const UPPER_BODY_BONES = new Set<VRMHumanBoneName>([
  VRMHumanBoneName.Spine,
  VRMHumanBoneName.Chest,
  VRMHumanBoneName.UpperChest,
  VRMHumanBoneName.Neck,
  VRMHumanBoneName.Head,
  VRMHumanBoneName.LeftShoulder,
  VRMHumanBoneName.RightShoulder,
  VRMHumanBoneName.LeftUpperArm,
  VRMHumanBoneName.RightUpperArm,
  VRMHumanBoneName.LeftLowerArm,
  VRMHumanBoneName.RightLowerArm,
  VRMHumanBoneName.LeftHand,
  VRMHumanBoneName.RightHand,
]);
const LOWER_BODY_BONES = new Set<VRMHumanBoneName>([
  VRMHumanBoneName.Hips,
  VRMHumanBoneName.LeftUpperLeg,
  VRMHumanBoneName.RightUpperLeg,
  VRMHumanBoneName.LeftLowerLeg,
  VRMHumanBoneName.RightLowerLeg,
  VRMHumanBoneName.LeftFoot,
  VRMHumanBoneName.RightFoot,
]);

function buildSeatedPose(
  vrm: VRM,
  motionCue: MotionCue,
  motionIntensity: number,
  reactionPulse: number,
  elapsed: number,
  includeArms: boolean,
  blended?: BlendedPose,
  conservativeRig = false,
): SeatedNormalizedPose {
  const q = (x: number, y: number, z: number) =>
    new THREE.Quaternion().setFromEuler(new THREE.Euler(x, y, z, 'XYZ')).toArray() as [
      number,
      number,
      number,
      number,
    ];

  const sway = Math.sin(elapsed * 2.2);
  const slow = Math.sin(elapsed * 1.2);
  const pose = blended?.pose ?? cuePose(motionCue, elapsed, motionIntensity, reactionPulse);
  const armPose = conservativeRig
    ? handPose(motionCue, elapsed, motionIntensity, reactionPulse, pose, true)
    : blended?.armPose ?? handPose(motionCue, elapsed, motionIntensity, reactionPulse, pose);

  return {
    [VRMHumanBoneName.Hips]: {
      position: [0, conservativeRig ? -0.1 : -0.14, -0.015 + pose.hipZ],
      rotation: q(-0.14 + pose.hipX, pose.hipY, 0),
    },
    [VRMHumanBoneName.Spine]: { rotation: q(0.12 + pose.spineX, pose.spineY, 0) },
    [VRMHumanBoneName.Chest]: { rotation: q(0.1 + pose.chestX, pose.chestY, pose.chestZ) },
    [VRMHumanBoneName.UpperChest]: { rotation: q(0.05 + pose.chestX * 0.55, pose.chestY * 0.45, pose.chestZ * 0.4) },
    [VRMHumanBoneName.Neck]: { rotation: q(-0.04 + pose.neckX, pose.neckY, 0) },
    [VRMHumanBoneName.Head]: { rotation: q(-0.08 + pose.headX, pose.headY, pose.headZ) },

    [VRMHumanBoneName.LeftUpperLeg]: { rotation: q(-1.42, 0.04, 0.05) },
    [VRMHumanBoneName.RightUpperLeg]: { rotation: q(-1.42, -0.04, -0.05) },
    [VRMHumanBoneName.LeftLowerLeg]: { rotation: q(1.54, 0, 0.02) },
    [VRMHumanBoneName.RightLowerLeg]: { rotation: q(1.54, 0, -0.02) },
    [VRMHumanBoneName.LeftFoot]: { rotation: q(-0.2, 0, 0.04) },
    [VRMHumanBoneName.RightFoot]: { rotation: q(-0.2, 0, -0.04) },

    ...(includeArms
      ? {
          [VRMHumanBoneName.LeftShoulder]: { rotation: q(0.05, 0, 0.08) },
          [VRMHumanBoneName.RightShoulder]: { rotation: q(0.05, 0, -0.08) },
          [VRMHumanBoneName.LeftUpperArm]: {
            rotation: q(armPose.upperArmX, armPose.leftUpperArmY, armPose.leftUpperArmZ),
          },
          [VRMHumanBoneName.RightUpperArm]: {
            rotation: q(armPose.upperArmX, armPose.rightUpperArmY, armPose.rightUpperArmZ),
          },
          [VRMHumanBoneName.LeftLowerArm]: {
            rotation: q(armPose.leftLowerArmX, armPose.leftLowerArmY, armPose.leftLowerArmZ),
          },
          [VRMHumanBoneName.RightLowerArm]: {
            rotation: q(armPose.rightLowerArmX, armPose.rightLowerArmY, armPose.rightLowerArmZ),
          },
          [VRMHumanBoneName.LeftHand]: {
            rotation: q(armPose.handX, armPose.leftHandY, armPose.leftHandZ),
          },
          [VRMHumanBoneName.RightHand]: {
            rotation: q(armPose.handX, armPose.rightHandY, armPose.rightHandZ),
          },
        }
      : {}),
  };
}

type PoseRuntimeOptions = {
  upperBody: boolean;
  lowerBody: boolean;
  conservativeRig?: boolean;
};

function normalizePoseObject(pose: SeatedNormalizedPose): SeatedNormalizedPose {
  const normalized: SeatedNormalizedPose = {};
  Object.entries(pose).forEach(([boneName, bonePose]) => {
    const name = boneName as VRMHumanBoneName;
    const cloned = cloneBonePose(bonePose);
    if (cloned) normalized[name] = cloned;
  });
  return normalized;
}

function cloneBonePose(bonePose: NormalizedBonePose | undefined): NormalizedBonePose | undefined {
  if (!bonePose) return undefined;
  const cloned: NormalizedBonePose = {};
  if (bonePose.position && bonePose.position.every(Number.isFinite)) {
    cloned.position = [...bonePose.position] as [number, number, number];
  }
  if (bonePose.rotation && bonePose.rotation.every(Number.isFinite)) {
    cloned.rotation = normalizedQuaternionArray(bonePose.rotation);
  }
  return cloned.position || cloned.rotation ? cloned : undefined;
}

function mergeSeatedPose(base: SeatedNormalizedPose, add: SeatedNormalizedPose): SeatedNormalizedPose {
  return clampSeatedPose({
    ...normalizePoseObject(base),
    ...normalizePoseObject(add),
  });
}

function filterSeatedPose(pose: SeatedNormalizedPose, options: PoseRuntimeOptions): SeatedNormalizedPose {
  const filtered: SeatedNormalizedPose = {};
  Object.entries(pose).forEach(([boneName, bonePose]) => {
    const name = boneName as VRMHumanBoneName;
    if (!shouldRuntimeControlBone(name, options)) return;
    const cloned = cloneBonePose(bonePose);
    if (cloned) filtered[name] = cloned;
  });
  return filtered;
}

function shouldRuntimeControlBone(name: VRMHumanBoneName, options: PoseRuntimeOptions) {
  if (UPPER_BODY_BONES.has(name)) return options.upperBody;
  if (LOWER_BODY_BONES.has(name)) return options.lowerBody;
  return false;
}

function blendSeatedPose(
  current: SeatedNormalizedPose,
  target: SeatedNormalizedPose,
  options: { upperAlpha: number; lowerAlpha: number },
): SeatedNormalizedPose {
  const next = normalizePoseObject(current);
  Object.entries(target).forEach(([boneName, targetBone]) => {
    const name = boneName as VRMHumanBoneName;
    const alpha = UPPER_BODY_BONES.has(name) ? options.upperAlpha : options.lowerAlpha;
    next[name] = blendBonePose(next[name], targetBone, alpha);
  });
  return clampSeatedPose(next);
}

function blendBonePose(
  current: NormalizedBonePose | undefined,
  target: NormalizedBonePose | undefined,
  alpha: number,
): NormalizedBonePose | undefined {
  const safeTarget = cloneBonePose(target);
  if (!safeTarget) return cloneBonePose(current);
  const safeCurrent = cloneBonePose(current) ?? safeTarget;
  const blended: NormalizedBonePose = {};
  if (safeTarget.position) {
    const currentPosition = safeCurrent.position ?? safeTarget.position;
    blended.position = [
      currentPosition[0] + (safeTarget.position[0] - currentPosition[0]) * alpha,
      currentPosition[1] + (safeTarget.position[1] - currentPosition[1]) * alpha,
      currentPosition[2] + (safeTarget.position[2] - currentPosition[2]) * alpha,
    ];
  }
  if (safeTarget.rotation) {
    const currentRotation = new THREE.Quaternion().fromArray(safeCurrent.rotation ?? safeTarget.rotation);
    const targetRotation = new THREE.Quaternion().fromArray(safeTarget.rotation);
    currentRotation.slerp(targetRotation, alpha).normalize();
    blended.rotation = currentRotation.toArray() as [number, number, number, number];
  }
  return blended.position || blended.rotation ? blended : undefined;
}

function clampSeatedPose(pose: SeatedNormalizedPose): SeatedNormalizedPose {
  const clamped: SeatedNormalizedPose = {};
  Object.entries(pose).forEach(([boneName, bonePose]) => {
    const name = boneName as VRMHumanBoneName;
    const cloned = cloneBonePose(bonePose);
    if (!cloned) return;
    if (name === VRMHumanBoneName.Hips && cloned.position) {
      cloned.position = [
        THREE.MathUtils.clamp(cloned.position[0], -0.045, 0.045),
        THREE.MathUtils.clamp(cloned.position[1], -0.18, 0.02),
        THREE.MathUtils.clamp(cloned.position[2], -0.09, 0.045),
      ];
    }
    if (cloned.rotation) {
      cloned.rotation = clampBoneRotation(name, cloned.rotation);
    }
    clamped[name] = cloned;
  });
  return clamped;
}

function clampBoneRotation(
  name: VRMHumanBoneName,
  rotation: [number, number, number, number],
): [number, number, number, number] {
  const limits = boneRotationLimits(name);
  if (!limits) return normalizedQuaternionArray(rotation);
  const euler = new THREE.Euler().setFromQuaternion(new THREE.Quaternion().fromArray(rotation).normalize(), 'XYZ');
  euler.x = THREE.MathUtils.clamp(euler.x, limits.x[0], limits.x[1]);
  euler.y = THREE.MathUtils.clamp(euler.y, limits.y[0], limits.y[1]);
  euler.z = THREE.MathUtils.clamp(euler.z, limits.z[0], limits.z[1]);
  return new THREE.Quaternion().setFromEuler(euler).normalize().toArray() as [number, number, number, number];
}

function boneRotationLimits(name: VRMHumanBoneName) {
  if (name === VRMHumanBoneName.Spine || name === VRMHumanBoneName.Chest || name === VRMHumanBoneName.UpperChest) {
    return { x: [-0.34, 0.34], y: [-0.34, 0.34], z: [-0.26, 0.26] };
  }
  if (name === VRMHumanBoneName.Neck || name === VRMHumanBoneName.Head) {
    return { x: [-0.56, 0.44], y: [-0.72, 0.72], z: [-0.36, 0.36] };
  }
  if (name === VRMHumanBoneName.LeftShoulder || name === VRMHumanBoneName.RightShoulder) {
    return { x: [-0.46, 0.46], y: [-0.5, 0.5], z: [-0.62, 0.62] };
  }
  if (name === VRMHumanBoneName.LeftUpperArm || name === VRMHumanBoneName.RightUpperArm) {
    return { x: [-0.58, 0.72], y: [-1.25, 1.25], z: [-1.85, 1.85] };
  }
  if (name === VRMHumanBoneName.LeftLowerArm || name === VRMHumanBoneName.RightLowerArm) {
    return { x: [-0.2, 1.35], y: [-1.52, 1.52], z: [-0.98, 0.98] };
  }
  if (name === VRMHumanBoneName.LeftHand || name === VRMHumanBoneName.RightHand) {
    return { x: [-0.5, 0.5], y: [-0.7, 0.7], z: [-0.46, 0.46] };
  }
  return undefined;
}

function normalizedQuaternionArray(rotation: [number, number, number, number]): [number, number, number, number] {
  const quaternion = new THREE.Quaternion().fromArray(rotation);
  if (!Number.isFinite(quaternion.lengthSq()) || quaternion.lengthSq() < 0.000001) {
    return [0, 0, 0, 1];
  }
  return quaternion.normalize().toArray() as [number, number, number, number];
}

function applySeatedPose(
  vrm: VRM,
  pose: SeatedNormalizedPose,
) {
  vrm.humanoid.resetNormalizedPose();
  vrm.humanoid.setNormalizedPose(clampSeatedPose(pose));
  vrm.humanoid.update();
  vrm.scene.updateMatrixWorld(true);
}

function createSafeNormalizedPoseRuntime() {
  let currentPose: SeatedNormalizedPose | null = null;
  return {
    reset(seedPose?: SeatedNormalizedPose) {
      currentPose = seedPose ? clampSeatedPose(seedPose) : null;
    },
    captureFromVrm(vrm: VRM, upperBodyOnly = false) {
      const pose = normalizePoseObject(vrm.humanoid.getNormalizedPose());
      const filtered = filterSeatedPose(pose, {
        upperBody: true,
        lowerBody: !upperBodyOnly,
      });
      currentPose = mergeSeatedPose(currentPose ?? {}, filtered);
    },
    apply(
      vrm: VRM,
      targetPose: SeatedNormalizedPose,
      delta: number,
      options: { upperBody: boolean; lowerBody: boolean; conservativeRig: boolean },
    ) {
      const target = filterSeatedPose(clampSeatedPose(targetPose), options);
      if (!Object.keys(target).length) return;
      if (!currentPose) {
        currentPose = target;
      } else {
        const upperAlpha = dampAlpha(delta, options.conservativeRig ? 0.18 : 0.12);
        const lowerAlpha = 1;
        currentPose = blendSeatedPose(currentPose, target, {
          upperAlpha,
          lowerAlpha,
        });
      }
      const poseToApply = filterSeatedPose(clampSeatedPose(currentPose), options);
      vrm.humanoid.setNormalizedPose(poseToApply);
      vrm.humanoid.update();
      vrm.scene.updateMatrixWorld(true);
    },
  };
}

function handPose(
  motionCue: MotionCue,
  elapsed: number,
  motionIntensity: number,
  reactionPulse: number,
  pose: ReturnType<typeof cuePose>,
  conservativeRig = false,
) {
  const intensity = clampMotionIntensity(motionIntensity);
  const rub = motionCue === 'rub_hands' ? Math.sin(elapsed * 6.2) * intensity * (1 + reactionPulse * 1.2) : 0;
  const fidget = motionCue === 'rub_hands' ? Math.sin(elapsed * 4.8) * intensity * (1 + reactionPulse) : 0;
  const guarded = motionCue === 'lean_back' ? -0.1 - reactionPulse * 0.08 : 0;
  const lowered = motionCue === 'look_down' ? 0.04 + reactionPulse * 0.05 : 0;

  if (conservativeRig) {
    return {
      upperArmX: 0.2 + pose.armX * 0.08 + guarded * 0.42,
      leftUpperArmY: 0.16 + pose.leftArmY * 0.05,
      rightUpperArmY: -0.16 + pose.rightArmY * 0.05,
      leftUpperArmZ: 1.08 - pose.leftArmZ * 0.05,
      rightUpperArmZ: -1.08 - pose.rightArmZ * 0.05,
      leftLowerArmX: 1.06 + pose.forearmX * 0.07 + lowered * 0.24 + rub * 0.005,
      rightLowerArmX: 1.06 + pose.forearmX * 0.07 + lowered * 0.24 - rub * 0.005,
      leftLowerArmY: -0.22 - fidget * 0.006,
      rightLowerArmY: 0.22 + fidget * 0.006,
      leftLowerArmZ: 0.08,
      rightLowerArmZ: -0.08,
      handX: -0.18,
      leftHandY: -0.06 - rub * 0.01,
      rightHandY: 0.06 + rub * 0.01,
      leftHandZ: 0.02,
      rightHandZ: -0.02,
    };
  }

  return {
    upperArmX: 0.28 + pose.armX * 0.1 + guarded * 0.85,
    leftUpperArmY: -0.04 + pose.leftArmY * 0.1,
    rightUpperArmY: 0.04 + pose.rightArmY * 0.1,
    leftUpperArmZ: -1.26 + pose.leftArmZ * 0.08,
    rightUpperArmZ: 1.26 + pose.rightArmZ * 0.08,
    leftLowerArmX: 1.08 + pose.forearmX * 0.14 + lowered * 0.58 + rub * 0.01,
    rightLowerArmX: 1.08 + pose.forearmX * 0.14 + lowered * 0.58 - rub * 0.01,
    leftLowerArmY: -0.42 - fidget * 0.014,
    rightLowerArmY: 0.42 + fidget * 0.014,
    leftLowerArmZ: 0.12,
    rightLowerArmZ: -0.12,
    handX: -0.2,
    leftHandY: -0.08 - rub * 0.02,
    rightHandY: 0.08 + rub * 0.02,
    leftHandZ: 0.02,
    rightHandZ: -0.02,
  };
}

function cuePose(motionCue: MotionCue, elapsed: number, motionIntensity: number, reactionPulse: number) {
  const intensity = clampMotionIntensity(motionIntensity);
  const nod = Math.sin(elapsed * 2.6);
  const avoid = Math.sin(elapsed * 0.9);
  const attentive = Math.sin(elapsed * 0.7);
  const base = {
    hipX: 0,
    hipY: 0,
    hipZ: 0,
    spineX: 0,
    spineY: attentive * 0.008,
    chestX: 0,
    chestY: attentive * 0.012,
    chestZ: 0,
    neckX: Math.sin(elapsed * 0.52) * 0.01,
    neckY: attentive * 0.018,
    headX: Math.sin(elapsed * 0.46) * 0.012,
    headY: attentive * 0.024,
    headZ: 0,
    armX: 0,
    forearmX: 0,
    leftArmY: 0,
    rightArmY: 0,
    leftArmZ: 0,
    rightArmZ: 0,
  };

  if (motionCue === 'look_down') {
    return scalePose({ ...base, spineX: 0.05, chestX: 0.08, neckX: -0.1, headX: -0.24 - reactionPulse * 0.12, armX: 0.08, forearmX: 0.08 }, intensity);
  }
  if (motionCue === 'avoid_eye_contact') {
    return scalePose({ ...base, chestY: avoid * 0.08, neckY: 0.16 + avoid * 0.04 + reactionPulse * 0.05, headY: 0.24 + avoid * 0.06 + reactionPulse * 0.12, headZ: -0.04 - reactionPulse * 0.03 }, intensity);
  }
  if (motionCue === 'rub_hands') {
    return scalePose({ ...base, chestX: 0.03, headX: -0.08 - reactionPulse * 0.04, armX: 0.14 + reactionPulse * 0.06, forearmX: 0.16 + reactionPulse * 0.12, leftArmY: 0.1, rightArmY: -0.1 }, intensity);
  }
  if (motionCue === 'lean_back') {
    return scalePose({ ...base, hipZ: -0.03 - reactionPulse * 0.05, hipX: -0.06 - reactionPulse * 0.04, spineX: -0.1 - reactionPulse * 0.1, chestX: -0.12 - reactionPulse * 0.12, headY: -0.08 - reactionPulse * 0.08, headZ: -reactionPulse * 0.03, armX: 0.03, forearmX: 0.04 }, intensity);
  }
  if (motionCue === 'slow_nod') {
    return scalePose({ ...base, chestX: 0.03, neckX: nod * 0.04, headX: nod * 0.12 + reactionPulse * 0.07 }, intensity);
  }
  return base;
}

function updateGazeTarget(
  camera: THREE.Camera,
  gazeTarget: THREE.Object3D,
  motionCue: MotionCue,
  motionIntensity: number,
  reactionPulse: number,
  elapsed: number,
  delta: number,
  transitionMs: number,
  gazePattern: AvatarGazePattern,
) {
  const intensity = clampMotionIntensity(motionIntensity);
  const microX = Math.sin(elapsed * 0.74) * 0.025;
  const microY = Math.sin(elapsed * 0.58 + 1.4) * 0.016;
  const target = new THREE.Vector3();
  camera.getWorldPosition(target);
  target.x += microX;
  target.y += microY;

  if (gazePattern === 'avoidant') {
    target.x += Math.sin(elapsed * 0.42) * 0.08 + 0.14 * intensity;
    target.y -= 0.06 * intensity;
  } else if (gazePattern === 'downward') {
    target.x += Math.sin(elapsed * 0.38) * 0.04;
    target.y -= 0.22 * intensity;
  } else if (gazePattern === 'scanning') {
    target.x += Math.sin(elapsed * 1.15) * 0.14 * intensity;
    target.y += Math.sin(elapsed * 0.82) * 0.035;
  } else if (gazePattern === 'guarded') {
    target.x -= 0.12 * intensity;
    target.y -= 0.035 * intensity;
  }

  if (motionCue === 'look_down') {
    target.x += Math.sin(elapsed * 0.45) * 0.035;
    target.y -= (0.42 + reactionPulse * 0.16) * intensity;
  } else if (motionCue === 'avoid_eye_contact') {
    target.x += (0.42 + reactionPulse * 0.18) * intensity;
    target.y -= 0.1 * intensity;
  } else if (motionCue === 'lean_back') {
    target.x -= (0.22 + reactionPulse * 0.12) * intensity;
    target.y -= 0.04 * intensity;
  } else if (motionCue === 'rub_hands') {
    target.x += Math.sin(elapsed * 1.8) * 0.12 * intensity;
    target.y -= 0.14 * intensity;
  } else if (motionCue === 'slow_nod') {
    target.y += Math.sin(elapsed * 1.3) * 0.035 * intensity;
  }

  gazeTarget.position.lerp(target, Math.max(dampAlpha(delta, (transitionMs / 1000) * 0.42), reactionPulse * 0.08));
}

function clampMotionIntensity(value: number) {
  if (typeof value !== 'number' || Number.isNaN(value)) return 1;
  return Math.min(1, Math.max(0.25, value));
}

function scalePose<T extends Record<string, number>>(pose: T, intensity: number): T {
  return Object.fromEntries(
    Object.entries(pose).map(([key, value]) => [key, value * intensity]),
  ) as T;
}
