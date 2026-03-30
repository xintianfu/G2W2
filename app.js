const canvas = document.getElementById("renderCanvas");
const video = document.getElementById("cameraVideo");
const statusEl = document.getElementById("status");

const snapshotPreview = document.getElementById("snapshotPreview");
const previewCtx = snapshotPreview.getContext("2d");
snapshotPreview.width = 512;
snapshotPreview.height = 512;

let engine, scene, xrHelper;
let snapshotPanel, snapshotMaterial, snapshotTexture, snapshotTextureCtx;

// 交互状态
let isGrabbingLeft = false; 
let wasPinchingRight = false;
let lastPinchTime = 0;

const PINCH_THRESHOLD = 0.02; // 右手捏合阈值 (4cm)
const FIST_THRESHOLD = 0.06;  // 左手握拳阈值 (平均距离小于6cm)
const GRAB_RANGE = 0.5;       // 左手抓取感应范围 (50cm)
const COOLDOWN = 1500;

const PANEL_TEX_WIDTH = 1024;
const PANEL_TEX_HEIGHT = 1024;
const PANEL_WORLD_WIDTH = 0.42;
const PANEL_WORLD_HEIGHT = 0.28;

function setStatus(text) {
    statusEl.textContent = `状态：${text}`;
    console.log(text);
}

// ---------- 1. 核心算法：获取关节世界坐标 ----------
function getJointPos(controller, jointName) {
    if (!controller?.inputSource?.hand) return null;
    const joint = controller.inputSource.hand.get(jointName);
    const frame = xrHelper?.baseExperience?.sessionManager?.currentFrame;
    const ref = xrHelper?.baseExperience?.sessionManager?.referenceSpace;
    if (!frame || !joint || !ref) return null;
    const pose = frame.getJointPose(joint, ref);
    return pose ? new BABYLON.Vector3(pose.transform.position.x, pose.transform.position.y, pose.transform.position.z) : null;
}

// ---------- 2. 核心算法：判定左手握拳 (Fist) ----------
function getLeftHandFistStrength(controller) {
    // 获取掌心作为参考点
    const palm = getJointPos(controller, "wrist");
    // 获取四个指尖
    const i = getJointPos(controller, "index-finger-tip");
    const m = getJointPos(controller, "middle-finger-tip");
    const r = getJointPos(controller, "ring-finger-tip");
    const p = getJointPos(controller, "pinky-finger-tip");

    if (!palm || !i || !m || !r || !p) return 1.0; // 数据不足返回一个大的距离

    // 计算四个指尖到掌心的平均距离
    const d1 = BABYLON.Vector3.Distance(i, palm);
    const d2 = BABYLON.Vector3.Distance(m, palm);
    const d3 = BABYLON.Vector3.Distance(r, palm);
    const d4 = BABYLON.Vector3.Distance(p, palm);

    return (d1 + d2 + d3 + d4) / 4;
}

// ---------- 3. 核心循环：物理距离判定交互 ----------
function updateLoop() {
    if (!xrHelper || xrHelper.baseExperience.state !== BABYLON.WebXRState.IN_XR) return;

    xrHelper.input.controllers.forEach((controller) => {
        const side = controller.inputSource.handedness;

        // --- 左手：握拳搬运逻辑 ---
        if (side === "left") {
            const fistDist = getLeftHandFistStrength(controller);
            const isFist = fistDist < FIST_THRESHOLD;
            const palmPos = getJointPos(controller, "wrist") || controller.pointer.position;

            if (snapshotPanel.isEnabled()) {
                const distToPanel = BABYLON.Vector3.Distance(palmPos, snapshotPanel.position);

                // 触发抓取：在50cm范围内且握拳
                if (distToPanel < GRAB_RANGE && isFist) {
                    if (!isGrabbingLeft) {
                        isGrabbingLeft = true;
                        snapshotMaterial.emissiveColor = new BABYLON.Color3(0, 0.8, 1); // 变蓝反馈
                        setStatus("左手握拳：抓取成功");
                    }
                }

                // 持续抓取：只要不松拳头就跟着走
                if (isGrabbingLeft) {
                    if (!isFist) {
                        isGrabbingLeft = false;
                        snapshotMaterial.emissiveColor = new BABYLON.Color3(1, 1, 1);
                        setStatus("左手松开：停止搬运");
                    } else {
                        // 1:1 坐标强制同步
                        snapshotPanel.setAbsolutePosition(palmPos);
                        snapshotPanel.lookAt(xrHelper.baseExperience.camera.globalPosition, Math.PI);
                    }
                }
            }
        } 
        // --- 右手：Pinch 截图逻辑 (已证实的有效逻辑) ---
        else if (side === "right") {
            const thumb = getJointPos(controller, "thumb-tip");
            const index = getJointPos(controller, "index-finger-tip");
            
            if (thumb && index) {
                const dist = BABYLON.Vector3.Distance(thumb, index);
                const isPinching = dist < PINCH_THRESHOLD;

                if (isPinching && !wasPinchingRight) {
                    if (performance.now() - lastPinchTime > COOLDOWN) {
                        lastPinchTime = performance.now();
                        updateSnapshotFromCurrentVideoFrame();
                        setStatus("右手 Pinch：截图保存");
                    }
                }
                wasPinchingRight = isPinching;
            }
        }
    });
}

// ---------- 4. 截图、绘画与启动逻辑 (保持稳定) ----------
function updateSnapshotFromCurrentVideoFrame() {
    if (!video.videoWidth) return;
    const ctx = snapshotTextureCtx;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, PANEL_TEX_WIDTH, PANEL_TEX_HEIGHT);
    ctx.save();
    ctx.translate(PANEL_TEX_WIDTH / 2, PANEL_TEX_HEIGHT / 2);
    ctx.scale(-1, 1); 
    ctx.translate(-PANEL_TEX_WIDTH / 2, -PANEL_TEX_HEIGHT / 2);
    ctx.drawImage(video, 0, 0, PANEL_TEX_WIDTH, PANEL_TEX_HEIGHT);
    ctx.restore();
    snapshotTexture.update();
    
    const cam = xrHelper.baseExperience.camera;
    snapshotPanel.position = cam.globalPosition.add(cam.getForwardRay(1).direction.scale(0.5));
    snapshotPanel.lookAt(cam.globalPosition, Math.PI); 
    snapshotPanel.setEnabled(true);

    const link = document.createElement("a");
    link.href = snapshotTexture.getContext().canvas.toDataURL("image/jpeg");
    link.download = `Shot_${Date.now()}.jpg`;
    link.click();
}

async function initXR() {
    xrHelper = await scene.createDefaultXRExperienceAsync({
        uiOptions: { sessionMode: "immersive-ar", referenceSpaceType: "local-floor" }
    });
    xrHelper.baseExperience.featuresManager.enableFeature(BABYLON.WebXRFeatureName.HAND_TRACKING, "latest", {
        xrInput: xrHelper.input
    });
}

async function bootstrap() {
    engine = new BABYLON.Engine(canvas, true);
    scene = new BABYLON.Scene(engine);
    new BABYLON.HemisphericLight("light", new BABYLON.Vector3(0, 1, 0), scene);

    snapshotPanel = BABYLON.MeshBuilder.CreatePlane("snapshotPanel", { width: PANEL_WORLD_WIDTH, height: PANEL_WORLD_HEIGHT, sideOrientation: BABYLON.Mesh.DOUBLESIDE }, scene);
    snapshotTexture = new BABYLON.DynamicTexture("sTex", { width: PANEL_TEX_WIDTH, height: PANEL_TEX_HEIGHT }, scene);
    snapshotTextureCtx = snapshotTexture.getContext();
    snapshotMaterial = new BABYLON.StandardMaterial("sMat", scene);
    snapshotMaterial.diffuseTexture = snapshotTexture;
    snapshotMaterial.emissiveColor = new BABYLON.Color3(1, 1, 1);
    snapshotMaterial.disableLighting = true;
    snapshotPanel.material = snapshotMaterial;
    snapshotPanel.setEnabled(false);

    const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" } });
    video.srcObject = stream;
    await video.play();

    await initXR();
    engine.runRenderLoop(() => { updateLoop(); scene.render(); });
}

bootstrap();