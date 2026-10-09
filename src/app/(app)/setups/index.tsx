import { router } from 'expo-router';
import { useState } from 'react';

import { Button, ListGroup, ListRow, Notice, Screen, Text } from '@/components';
import { useProfile } from '@/features/settings/useProfile';
import { describeSetup, resolveSetup, TEMPLATE_CHOICES } from '@/features/setups/setups';
import { createSetupFromTemplate } from '@/features/setups/setupsRepo';
import { useSetups } from '@/features/setups/useSetups';
import { haptic } from '@/theme';

/**
 * The user's setups (places they train), with the default marked. A tap opens one to edit; "Add a
 * setup" opens a blank one. With no setups yet, one-tap templates make the first one.
 */
export default function SetupsScreen() {
  const { profile, userId } = useProfile();
  const { setups, isLoading } = useSetups();
  const current = resolveSetup(setups, profile.defaultSetupId);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const quickCreate = async (template: (typeof TEMPLATE_CHOICES)[number]['template']) => {
    if (!userId || busy) return;
    setBusy(true);
    setError(null);
    try {
      // The first setup becomes the default (it already is in effect: it is the only one).
      await createSetupFromTemplate(userId, template, setups.map((setup) => setup.name), { makeDefault: setups.length === 0 });
      haptic('success');
    } catch (problem) {
      setError(`Couldn't save the setup on this phone: ${String(problem)}`);
      haptic('error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Screen
      edges={['bottom', 'left', 'right']}
      footer={<Button label="Add a setup" size="comfortable" onPress={() => router.push({ pathname: '/setups/[id]', params: { id: 'new' } })} />}
    >
      <Text tone="secondary">
        A setup is a place you train and the gear you have there. Circuits only use exercises that fit the setup you pick.
      </Text>

      {setups.length === 0 && !isLoading ? (
        <ListGroup title="Start with one tap" description="You can change the gear afterwards.">
          {TEMPLATE_CHOICES.map((choice) => (
            <ListRow
              key={choice.template}
              title={choice.label}
              disabled={busy || !userId}
              accessibilityHint="Creates this setup"
              onPress={() => void quickCreate(choice.template)}
            />
          ))}
        </ListGroup>
      ) : (
        <ListGroup title="Your setups">
          {setups.map((setup) => (
            <ListRow
              key={setup.id}
              title={setup.name}
              subtitle={describeSetup(setup)}
              badge={setup.id === current?.id ? 'Default' : undefined}
              onPress={() => router.push({ pathname: '/setups/[id]', params: { id: setup.id } })}
            />
          ))}
        </ListGroup>
      )}

      {error ? <Notice tone="danger" title="Not saved" message={error} /> : null}
    </Screen>
  );
}
