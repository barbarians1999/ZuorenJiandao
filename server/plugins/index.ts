// Local editing services and external MCP control only. No embedded AI runtime.
import type { Plugin } from 'vite';
import { crossOriginIsolationPlugin } from './cross-origin-isolation.ts';
import { storageLifecyclePlugin } from './storage-lifecycle.ts';
import { projectStorePlugin } from './project-store-plugin.ts';
import { extensionStorePlugin } from './extension-store.ts';
import { exportPlugin } from './export.ts';
import { exportQaPlugin } from './export-qa.ts';
import { exportDestinationPlugin } from './export-destination.ts';
import { exportStagePlugin } from './export-stage.ts';
import { uploadPlugin } from './upload.ts';
import { mobileUploadPlugin } from './mobile-upload.ts';
import { uploadMultipartPlugin } from './upload-multipart.ts';
import { extractAudioPlugin } from './extract-audio.ts';
import { hfProxyPlugin } from './hf-proxy.ts';
import { asrModelsPlugin } from './asr-models.ts';
import { modelPacksPlugin } from './model-packs.ts';
import { extractFramesPlugin } from './extract-frames.ts';
import { sceneDetectionPlugin } from './scene-detection.ts';
import { autoGradePlugin } from './auto-grade.ts';
import { mediaPreviewPlugin } from './media-preview.ts';
import { isolateVoicePlugin } from './isolate-voice.ts';
import { normalizeMediaPlugin } from './normalize-media.ts';
import { probeMediaPlugin } from './probe-media.ts';
import { subtitleExportPlugin } from './subtitles.ts';
import { settingsPlugin } from './settings.ts';
import { projectReleasePlugin } from './project-release.ts';
import { skillFilesPlugin } from './skill-files.ts';
import { externalAgentPlugin } from './external-agent.ts';
import { installSystemProxy } from '../net.ts';
import { requestShapeGatePlugin } from './request-shape-gate';
import { removedAiRoutesPlugin } from './removed-ai-routes.ts';

export function serverPlugins(options: { projectStoreHttp?: boolean } = {}): Plugin[] {
  installSystemProxy();
  return [
    requestShapeGatePlugin(), crossOriginIsolationPlugin(), removedAiRoutesPlugin(),
    storageLifecyclePlugin(), skillFilesPlugin(),
    projectStorePlugin({ http: options.projectStoreHttp }), extensionStorePlugin(),
    externalAgentPlugin(), settingsPlugin(), projectReleasePlugin(), exportStagePlugin(), exportPlugin(),
    exportDestinationPlugin(), exportQaPlugin(), uploadMultipartPlugin(), uploadPlugin(),
    mobileUploadPlugin(), extractAudioPlugin(), hfProxyPlugin(), asrModelsPlugin(),
    modelPacksPlugin(), extractFramesPlugin(), sceneDetectionPlugin(), autoGradePlugin(),
    mediaPreviewPlugin(), isolateVoicePlugin(), normalizeMediaPlugin(), probeMediaPlugin(),
    subtitleExportPlugin(),
  ];
}
