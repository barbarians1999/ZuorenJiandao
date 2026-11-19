import assert from 'node:assert/strict';
import {
  computeTightCaptionFrameInsets,
  computeTightTextareaMetrics,
} from './captionPreviewBoxGeometry';

// Empty or invalid container returns null safely.
assert.equal(computeTightCaptionFrameInsets({ left: 0, right: 0, width: 0 }, []), null);
assert.equal(
  computeTightCaptionFrameInsets({ left: 100, right: 500, width: 400 }, [{ left: 120, right: 120, width: 0, height: 24 }]),
  null,
);

// Wrapped multi-line glyph rects produce tight horizontal frame insets inside the wider column container.
{
  const insets = computeTightCaptionFrameInsets(
    { left: 100, right: 700, width: 600 },
    [
      { left: 260, right: 540, width: 280, height: 32 },
      { left: 310, right: 490, width: 180, height: 32 },
    ],
    8,
  );
  assert.deepEqual(insets, { left: 152, right: 152 }, '选框左右应从 600px 列宽收紧到实际文字最宽包络+边距');
}

// Even when glyphs touch the edge of the container, padding stays bounded at -horizontalPad.
{
  const insets = computeTightCaptionFrameInsets(
    { left: 100, right: 300, width: 200 },
    [{ left: 100, right: 300, width: 200, height: 30 }],
    8,
  );
  assert.deepEqual(insets, { left: -8, right: -8 });
}

// Inline textarea metrics stay compact for short text and grow in rows when wrapped or explicit newlines exist.
{
  const short = computeTightTextareaMetrics({
    text: '短句字幕',
    font: '700 32px sans-serif',
    fontSize: 32,
    maxWidthPx: 640,
  });
  assert.ok(short.widthPx < 640, '短句字幕输入框不得铺满 640px 列宽');
  assert.equal(short.rows, 1);

  const multiline = computeTightTextareaMetrics({
    text: '第一行字幕\n第二行字幕',
    font: '700 32px sans-serif',
    fontSize: 32,
    maxWidthPx: 640,
  });
  assert.equal(multiline.rows, 2, '显式换行必须增加输入行数');

  const wrapped = computeTightTextareaMetrics({
    text: '这是一段很长很长会自动折行显示的测试字幕文本内容用来验证宽度封顶与行数计算',
    font: '700 32px sans-serif',
    fontSize: 32,
    maxWidthPx: 300,
  });
  assert.equal(wrapped.widthPx, 300, '超长字幕输入宽度封顶在 maxWidthPx');
  assert.ok(wrapped.rows >= 2, '超长字幕必须自动折行并扩大 rows');
}

console.log('captionPreviewBoxGeometry.verify: ok (tight insets & compact inline textarea)');
