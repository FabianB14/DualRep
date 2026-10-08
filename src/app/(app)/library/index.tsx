import { router } from 'expo-router';
import { useMemo, useState } from 'react';
import { FlatList, KeyboardAvoidingView, ScrollView, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { useAuth } from '@/auth/AuthProvider';
import { Button, Chip, ListRow, Notice, Text, TextField } from '@/components';
import { useTrainingDefaults } from '@/features/settings/useTrainingDefaults';
import { describeEquipment } from '@/features/training/equipment';
import { filterLibrary, MOVEMENT_PATTERN_LABELS, MOVEMENT_PATTERNS } from '@/features/training/library';
import type { LibraryExercise, MovementPattern } from '@/features/training/types';
import { useLibrary } from '@/features/training/useLibrary';
import { useTheme } from '@/theme';

/** "Squat · Dumbbells" or "Core · No equipment". */
function exerciseSubtitle(exercise: LibraryExercise): string {
  const pattern = exercise.movementPattern ? MOVEMENT_PATTERN_LABELS[exercise.movementPattern] : 'Other';
  return `${pattern} · ${describeEquipment(exercise.equipment) || 'No equipment'}`;
}

/**
 * Browse the exercise library (the synced library merged with the bundled starter exercises, so it
 * is full offline): search by name or muscle, filter by movement, and "Fits my setup". The search
 * and filters stay on top; the list scrolls under them.
 */
export default function LibraryScreen() {
  const { colors, space } = useTheme();
  const { user } = useAuth();
  const { exercises, isLoading } = useLibrary();
  const { setup } = useTrainingDefaults();
  const [query, setQuery] = useState('');
  const [pattern, setPattern] = useState<MovementPattern | null>(null);
  const [fitsOnly, setFitsOnly] = useState(false);

  const results = useMemo(
    () => filterLibrary(exercises, { query, pattern, setup: fitsOnly ? setup : null }),
    [exercises, query, pattern, fitsOnly, setup],
  );
  const filtered = query.trim() !== '' || pattern !== null || fitsOnly;

  const header = (
    <View style={{ gap: space[3], paddingHorizontal: space[5], paddingTop: space[3], paddingBottom: space[2] }}>
      <TextField
        label="Search"
        value={query}
        onChangeText={setQuery}
        placeholder="Name or muscle, e.g. squat, glutes"
        autoCapitalize="none"
        autoCorrect={false}
        returnKeyType="search"
        clearButtonMode="while-editing"
      />
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={{ gap: space[2] }}
        accessibilityLabel="Filter by movement"
      >
        <Chip
          label={setup ? `Fits ${setup.name}` : 'Fits my setup'}
          role="checkbox"
          selected={fitsOnly && setup !== null}
          disabled={setup === null}
          accessibilityHint={setup ? 'Shows only exercises you can do with this setup' : 'Add a setup first'}
          onPress={() => setFitsOnly((value) => !value)}
        />
        <Chip label="All moves" role="radio" selected={pattern === null} onPress={() => setPattern(null)} />
        {MOVEMENT_PATTERNS.map((value) => (
          <Chip
            key={value}
            label={MOVEMENT_PATTERN_LABELS[value]}
            role="radio"
            selected={pattern === value}
            onPress={() => setPattern((current) => (current === value ? null : value))}
          />
        ))}
      </ScrollView>
      <Text variant="caption" tone="secondary" accessibilityLiveRegion="polite">
        {isLoading && exercises.length === 0
          ? 'Loading…'
          : `${results.length} ${results.length === 1 ? 'exercise' : 'exercises'}${filtered ? ' match' : ''}`}
      </Text>
    </View>
  );

  return (
    <SafeAreaView edges={['bottom', 'left', 'right']} style={{ flex: 1, backgroundColor: colors.background }}>
      <KeyboardAvoidingView behavior="padding" style={{ flex: 1 }}>
        {header}
        <FlatList
          data={results}
          keyExtractor={(exercise) => exercise.id}
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode="on-drag"
          contentContainerStyle={{ paddingHorizontal: space[5], paddingBottom: space[4] }}
          ItemSeparatorComponent={() => <View style={{ height: 1, backgroundColor: colors.border, marginLeft: space[4] }} />}
          renderItem={({ item }) => (
            <View style={{ backgroundColor: colors.surface }}>
              <ListRow
                title={item.name}
                subtitle={exerciseSubtitle(item)}
                badge={item.origin !== 'user' ? undefined : item.ownerId === user?.id ? 'Yours' : 'Shared'}
                onPress={() => router.push({ pathname: '/library/[id]', params: { id: item.id } })}
              />
            </View>
          )}
          ListEmptyComponent={
            isLoading ? null : (
              <View style={{ gap: space[3], paddingTop: space[4] }}>
                <Notice title="No exercises match" message="Try fewer words, or clear the filters." />
                {filtered ? (
                  <Button
                    label="Clear filters"
                    variant="secondary"
                    onPress={() => {
                      setQuery('');
                      setPattern(null);
                      setFitsOnly(false);
                    }}
                  />
                ) : null}
              </View>
            )
          }
        />
        <View
          style={{
            paddingHorizontal: space[5],
            paddingTop: space[3],
            paddingBottom: space[4],
            borderTopWidth: 1,
            borderTopColor: colors.border,
            backgroundColor: colors.background,
          }}
        >
          <Button label="Add an exercise" size="comfortable" onPress={() => router.push('/library/new')} />
        </View>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}
