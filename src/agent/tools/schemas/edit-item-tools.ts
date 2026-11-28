import type { AgentToolSchema } from '../../tool-schema';

export const EDIT_ITEM_TOOL_SCHEMAS: AgentToolSchema[] = [
  {
    name: 'edit_item',
    description:
      'Unified item-level operations across video, image, audio, gif, svg, motion-graphic, text, solid, effect, and transition types. '
      + 'Flex crop (flexcrop) is a spatial inset crop — not a timeline trim. Use edit_item updates.transform.crop or transform.flexCrop {left?,right?,top?,bottom?} in composition pixels (Crop Left/Right 0..canvas width, Crop Top/Bottom 0..canvas height; cropped pixels are fully transparent; null clears). '
      + 'The user does not need to say "one pass", "do not recheck frames", or "do not use run_code" — those are the default. "Keep only the dashboard/panel/region" = crop the selected clip (omit itemId or pass "selected") so only that region remains, then stop. Set every needed edge in one update. Do not call run_code, probe_media, e2b, or edit_asset. '
      + 'adds place library items (effect/transition/zoom/MG/SFX), a POOL asset as a clip (type=video|image|gif|svg|audio, assetId=…), OR authored clips without assetId: type=text (text/fontSize/color/fontWeight/align/anchor/accentBarPosition?), type=solid (color/paperPreset?), or type=shape (shapeKind:"line"|"rect"|"arrow", 1..20px strokeWidth). '
      + 'updates move/trim/retime by itemId|id. Omit itemId or pass "selected" to target the inspector selection (read_project.timeline.selectedId). If the user names the selected clip, do not pick a neighboring track. Video aliases are bottom-up (V1 = bottom video). Passing assetId on a file-backed clip atomically replaces it from the media pool while preserving item id, track, timeline start, duration, and visual/audio edit state. '
      + 'fromFrame is the canonical timing field (startFrame is accepted as an alias). Unknown fields reject the entire call with "unknown field" + Did you mean. '
      + 'Entries run in adds→updates→deletes order against one private draft; only a fully valid/applied draft is published once. Any validator or draft-apply failure discards it with no partial timeline state. '
      + 'validateOnly runs that same sequential draft without publishing. Mutating calls then go through propose→apply. split_item cuts clips.',
    input_schema: {
      type: 'object',
      properties: {
        adds: {
          type: 'array',
          description:
            'effect: {type,targetItemId,assetId,propertyOverrides?}. transition: {type,assetId:"builtin:tr-*",incomingItemId,outgoingItemId?,durationInFrames?,direction?,originX?,originY?,lineColor?,lineWidthPx?} (e.g. builtin:tr-ink-bleed {originX,originY}, builtin:tr-clean-line-wipe|builtin:tr-archival-line-wipe {direction,lineColor,lineWidthPx}). motion-graphic: {type,assetId:"library:motion-graphic:*",track?,fromFrame|startFrame?,durationInFrames?,name?,props?} — supports 5 fill-and-use explainer kits: zuoren-explainer-scan-focus (labelText:"" hides label box leaving scan frame + bent leader + dot; optional endX/endY 0..100% auto-bends leader to target point), zuoren-explainer-flow-steps, zuoren-explainer-data-counter, zuoren-explainer-quote-card, zuoren-explainer-strike-refute. audio SFX: {type:"audio",assetId:library:sound:*,fromFrame?}. POOL media B-roll (video/image/gif/svg/audio): {type,assetId,track|trackId?,fromFrame|startFrame?,durationInFrames?} — no name/props on pool adds (then update_item_props). Source-window add accepts exact frames {sourceStartFrame?,sourceDurationInFrames?} or time bounds {sourceStartMs?,sourceEndMs?,sourceStartSeconds?,sourceEndSeconds?}; use one representation and do not combine it with durationInFrames/srcInFrame. Authored text: {type:"text",text,name?,track?,fromFrame?,durationInFrames?,fontFamily?,fontSize?,color?,fontWeight?,align?,anchor?,textStylePreset?,backgroundColor?,backgroundOpacity?,backgroundPaddingX?,backgroundPaddingY?,backgroundRadius?,accentBarPosition?,accentBarColor?,accentBarWidth?,shadowEnabled?,shadowColor?,shadowOpacity?,shadowBlur?,shadowOffsetX?,shadowOffsetY?,strokeColor?,strokeWidth?,strikeAnimated?,strikeColor?,strikeThickness?,strikeStartSec?,strikeDurationSec?,props?} (textStylePreset:"archival-tag"|"archival-top-tag"|"refute-strike"; setting backgroundColor without backgroundOpacity defaults to visible opacity 100 or preserves rgba/8-hex alpha, and 0..1 floats auto-scale to %). Anchor coordinate origin: anchor:"center"(default) origin is canvas center (50%,50%) → transform.x=tx-50, transform.y=ty-50; anchor:"top-left" origin is (5%,8.89%) i.e. 96×96px on 1080p → transform.x=tx-5, transform.y=ty-8.89; anchor:"middle-left" origin is (5%,50%) → transform.x=tx-5, transform.y=ty-50. Authored solid: {type:"solid",color?,paperPreset?,paperCenterColor?,paperMidColor?,paperEdgeColor?,paperLineColor?,paperGrain?,paperVignette?,paperAccentLine?,name?,track?,fromFrame?,durationInFrames?,props?} (paperPreset: "crimson-archive"|"warm-xuan"|"charcoal-dossier"|"ink-blueprint"|"custom"). Authored vector shape: {type:"shape",shapeKind:"line"|"rect"|"arrow",x1?,y1?,x2?,y2?,x?,y?,width?,height?,color?,strokeWidth?,dashPattern?,opacity?,cornerRadius?,fillColor?,fillOpacity?,arrowHeadSize?,bidirectional?,name?,track?,fromFrame?,durationInFrames?,props?}.',
          items: { type: 'object' },
        },
        updates: {
          type: 'array',
          description:
            'Generic clip update — type MUST be the item\'s actual kind, one of: video, audio, image, gif, svg, text, solid, motion-graphic, sequence. NEVER write the literal "generic" or "clip" as type — they are rejected ("update type not supported"). Shape: {type,itemId|id,track|trackId?,fromFrame|startFrame?,durationInFrames?,srcInFrame|sourceStartFrame?,sourceDurationInFrames?,props?,volume?,fadeInSeconds?,fadeOutSeconds?,keyframes?,clearKeyframes?,filters?,transform?,backgroundFill?,backgroundFillStrength?,speed|playbackRate?,disabled|pictureDisabled?}. Image/video cutout & archival styling goes in props: {singleSideFade?,fadeSide?:"bottom"|"top"|"left"|"right",bottomFade?,edgeFade?,dropShadow?,dropShadowBlur?,dropShadowOpacity?,dropShadowOffsetY?,archivalCard?,archivalTilt?,archivalBw?,archivalBorder?}. Exact pool replacement: {type,itemId|id,assetId,sourceStartFrame?,sourceDurationInFrames?}; default replacement keeps the original timeline duration and resets the new source in-point to zero. Explicit slip: {operation:"slip",itemId|id,deltaInFrames}; positive moves the source window later, negative earlier, while timeline placement/duration stay fixed. The result reports appliedDeltaInFrames, srcInFrame, sourceWindow, clamped/status, or a structured code for unknown/invalid inputs. '
            + 'Media source ops: {operation:"replace_media",itemId,src} bakes/swaps the clip to a video shell at the same slot; {operation:"relink_media",itemId,src,name?,durationInFrames?,width?,height?} clip-only relink (detaches pool master — use manage_media_pool relink_asset to update pool + all clips). '
            + 'keyframes: {x|y|scale|rotation|opacity|volume:[{frame,value,easing?}]} item-local frames; easing is stored on the left keyframe and controls the following interval. It accepts linear/easeIn/easeOut/easeInOut/cubicOut/springOut (and CSS/kebab aliases ease-in/ease-out/ease-in-out/cubic-out/spring-out). cubicOut is fast-out slow-stop; springOut adds micro-rebound overshoot. clearKeyframes:true clears all, or clearKeyframes:"opacity" for one prop. '
            + 'filters: {brightness?,contrast?,saturate? 0..2 (1=normal), blur? 0..30 px} on visual clips. transform: {scale? 0.05..16, x?/y? % of canvas, rotation? deg, opacity? 0..1, borderRadius?, crop?|flexCrop?: {left?,right?,top?,bottom?} composition pixels}. Flex crop (flexcrop) = Crop Left/Right/Top/Bottom; left/right 0..canvas width px, top/bottom 0..canvas height px; cropped pixels are fully transparent; null clears. backgroundFill:true fills unused canvas with a blurred copy; backgroundFillStrength sets an exact integer percentage from 0 to 100 and enables the fill when used alone. Only video/image clips on the bottom video track (V1). speed/playbackRate: 0.1..8 on video/audio/gif (retimes duration). disabled/pictureDisabled: boolean — disables or re-enables the whole clip (video transparent and audio muted, matching the V shortcut; clip stays on the timeline). '
            + 'No CSS layout fields (left/right/top/bottom/width/height) — position clips via transform or keyframes x/y; for text clips keep anchor math consistent: center origin (50%,50%) → x=tx-50, y=ty-50; top-left origin (5%,8.89%) → x=tx-5, y=ty-8.89; middle-left origin (5%,50%) → x=tx-5, y=ty-50; flex crop belongs in transform.crop or transform.flexCrop, not top-level left/right/top/bottom. layout INSIDE an MG belongs in its code/props. Text card updates with backgroundColor auto-enable visible backgroundOpacity when omitted, and textStylePreset cleanly re-applies preset card defaults. '
            + 'effect/transition/zoom updates as before (effect assetId swap is for FX stack, not clip media). transition update supports {type:"transition",id,assetId?,transitionType?,durationInFrames?,direction?,originX?,originY?,lineColor?,lineWidthPx?}.',
          items: { type: 'object' },
        },
        deletes: {
          type: 'array',
          description:
            'Generic clip: {type,itemId|id,ripple?} (ripple closes the gap). effect: {type:"effect",id|effectId,targetItemId?} or clear with targetItemId only. transition: {type:"transition",id}. zoom: {type:"effect",targetItemId,assetId:"builtin:zoom"}.',
          items: { type: 'object' },
        },
        ripple: {
          type: 'boolean',
          description:
            'When true, MG/audio adds push later same-track items (insert). Do not combine with validateOnly.',
        },
        validateOnly: {
          type: 'boolean',
          description: 'If true, use the same sequential private draft to validate the entire request, then discard it without publishing.',
        },
        projectId: { type: 'string', description: 'Ignored. The project currently targeted by this agent session is used.' },
      },
      additionalProperties: false,
    },
  },
];

export const EDIT_ITEM_TOOL_NAMES = new Set(EDIT_ITEM_TOOL_SCHEMAS.map((t) => t.name));
