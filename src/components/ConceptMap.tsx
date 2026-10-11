import { useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import Svg, { Line } from 'react-native-svg';

import { haptic, useTheme } from '@/theme';

import { MAP_MAX_NEIGHBORS, mapGeometry, radialLayout, type MapNeighbor } from './conceptMapLayout';
import { Text } from './Text';

export type ConceptMapProps = {
  /** The card in the middle. */
  center: { cardId: string; question: string };
  /** Cards linked to it (mapNeighbors); the first six are drawn. */
  neighbors: readonly MapNeighbor[];
  /** A linked card was tapped: put it in the middle. */
  onSelect(cardId: string): void;
};

/**
 * The concept map: the selected card in the middle, the cards linked to it around it, each with how
 * it relates ("Learn this first"). Tapping a card moves it to the middle. The lines are drawn with
 * react-native-svg and hidden from screen readers; the cards are ordinary buttons (at least 48 dp)
 * with the relation in their label, so the map works with touch, TalkBack and Switch Access alike.
 * The screen lists every link under the map as well, for anyone who prefers a list.
 */
export function ConceptMap({ center, neighbors, onSelect }: ConceptMapProps) {
  const { colors, radius, space } = useTheme();
  const [width, setWidth] = useState(0);
  const { area, node, center: middle } = mapGeometry(width);
  const shown = neighbors.slice(0, MAP_MAX_NEIGHBORS);
  const points = radialLayout(shown.length, area, node);
  const cx = area.width / 2;
  const cy = area.height / 2;

  return (
    <View onLayout={(event) => setWidth(event.nativeEvent.layout.width)} style={{ alignSelf: 'stretch' }}>
      {width > 0 ? (
        <View style={{ width: area.width, height: area.height, alignSelf: 'center' }}>
          <Svg
            width={area.width}
            height={area.height}
            style={StyleSheet.absoluteFill}
            accessibilityElementsHidden
            importantForAccessibility="no-hide-descendants"
          >
            {points.map((point, index) => (
              <Line
                key={shown[index].cardId}
                x1={cx}
                y1={cy}
                x2={point.x}
                y2={point.y}
                stroke={colors.borderStrong}
                strokeWidth={2}
                strokeLinecap="round"
              />
            ))}
          </Svg>
          <View
            accessible
            accessibilityLabel={`In the middle: ${center.question}`}
            style={{
              position: 'absolute',
              left: cx - middle.width / 2,
              top: cy - middle.height / 2,
              width: middle.width,
              height: middle.height,
              borderRadius: radius.lg,
              borderWidth: 2,
              borderColor: colors.mind.solid,
              backgroundColor: colors.mind.subtle,
              padding: space[2],
              justifyContent: 'center',
            }}
          >
            <Text variant="caption" style={{ fontWeight: '600' }} numberOfLines={4} align="center">
              {center.question}
            </Text>
          </View>
          {shown.map((neighbor, index) => {
            const point = points[index];
            const relations = neighbor.relations.join(' · ');
            return (
              <Pressable
                key={neighbor.cardId}
                accessibilityRole="button"
                accessibilityLabel={`${relations}: ${neighbor.question}`}
                accessibilityHint="Puts this card in the middle"
                onPress={() => {
                  haptic('select');
                  onSelect(neighbor.cardId);
                }}
                style={({ pressed }) => ({
                  position: 'absolute',
                  left: point.x - node.width / 2,
                  top: point.y - node.height / 2,
                  width: node.width,
                  height: node.height,
                  borderRadius: radius.md,
                  borderWidth: 1.5,
                  borderColor: colors.borderStrong,
                  backgroundColor: pressed ? colors.surfaceMuted : colors.surface,
                  padding: space[2],
                  gap: 2,
                })}
              >
                <Text variant="caption" tone="mind" numberOfLines={1} style={{ fontWeight: '600' }}>
                  {relations}
                </Text>
                <Text variant="caption" numberOfLines={3}>
                  {neighbor.question}
                </Text>
              </Pressable>
            );
          })}
        </View>
      ) : null}
    </View>
  );
}
