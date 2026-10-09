import { useCallback, useRef, useState, type RefObject } from 'react';
import type { View } from 'react-native';

/**
 * Where a view starts below the top of the window, for KeyboardAvoidingView's keyboardVerticalOffset.
 * React Native works out the keyboard padding from the keyboard's top, in window coordinates, and the
 * view's frame, relative to its parent. Under a navigation header the two differ by the header's
 * height, so the padding comes out that much short and a pinned footer (the screen's Save button)
 * stays under the keyboard. Put `ref` and `onLayout` on a plain View that holds the
 * KeyboardAvoidingView at its top, and pass `top` as the offset. 0 until measured; for a screen with
 * no header it is the status-bar inset the frame already counts, so the padding comes out the same.
 */
export function useWindowTop(): { ref: RefObject<View | null>; onLayout: () => void; top: number } {
  const ref = useRef<View>(null);
  const [top, setTop] = useState(0);
  const onLayout = useCallback(() => {
    ref.current?.measureInWindow((_x, y) => {
      if (Number.isFinite(y)) setTop(Math.max(0, y));
    });
  }, []);
  return { ref, onLayout, top };
}
