// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
import {
  ActionIcon,
  Button,
  Group,
  NumberInput,
  Select,
  Stack,
  Text,
  Title,
  TextInput,
  Textarea,
  Divider,
} from '@mantine/core';
import { IconPlus, IconTrash } from '@tabler/icons-react';
import { showNotification } from '@mantine/notifications';
import { normalizeErrorString } from '@medplum/core';
import type { PlanDefinition, PlanDefinitionAction } from '@medplum/fhirtypes';
import { Document, useMedplum } from '@medplum/react';
import { useState } from 'react';
import type { JSX } from 'react';
import { useNavigate } from 'react-router';

// ---- Condition types -------------------------------------------------

type ConditionKind = 'observation' | 'medication' | 'clinicalCondition' | 'demographic';
type Connector = 'AND' | 'OR';

type ObservationOperator = '>' | '<' | '>=' | '<=' | '=';
type DemographicField = 'age' | 'ses';
type ObservationType = 'temperature' | 'heatIndex';

interface RuleCondition {
  id: string;
  kind: ConditionKind;
  connector: Connector; // connector joining this condition to the PREVIOUS one (ignored for first item)

  // observation fields
  observationType?: ObservationType;
  operator?: ObservationOperator;
  value?: number;

  // medication fields — RxNorm only (standard US medication coding system)
  medicationCode?: string; // RxNorm code, e.g. "284399"

  // clinical condition fields — ICD-10-CM only (standard US diagnosis coding system)
  icd10Code?: string; // e.g. "J45.909" (Asthma, unspecified)

  // demographic fields
  demographicField?: DemographicField;
  demographicOperator?: ObservationOperator;
  demographicValue?: string; // age number as string, or SES level
}

// ---- Action types -------------------------------------------------

type ActionKind = 'task' | 'sms' | 'email';
type TaskPriority = 'routine' | 'urgent' | 'asap' | 'stat';

interface RuleAction {
  id: string;
  kind: ActionKind;

  // task fields
  taskTitle?: string;
  taskPriority?: TaskPriority;
  taskMessage?: string; // task description / instructions for care team

  // sms fields
  smsMessage?: string; // message sent to patient

  // email fields
  emailSubject?: string;
  emailMessage?: string;
}

function makeId(): string {
  return Math.random().toString(36).slice(2, 10);
}

function newCondition(connector: Connector = 'AND'): RuleCondition {
  return {
    id: makeId(),
    kind: 'observation',
    connector,
    observationType: 'temperature',
    operator: '>',
    value: 90,
  };
}

function newAction(): RuleAction {
  return {
    id: makeId(),
    kind: 'task',
    taskTitle: 'Follow up with patient',
    taskPriority: 'routine',
    taskMessage: '',
  };
}

// ---- FHIRPath generation ----------------------------------------------

function buildExpressionForCondition(c: RuleCondition): string {
  switch (c.kind) {
    case 'observation':
      return `Observation.where(code.text='${c.observationType}').valueQuantity.value ${c.operator ?? '>'} ${c.value ?? 0}`;
    case 'medication':
      return `MedicationRequest.medicationCodeableConcept.coding.where(system='http://www.nlm.nih.gov/research/umls/rxnorm' and code='${c.medicationCode ?? ''}').exists()`;
    case 'clinicalCondition':
      return `Condition.code.coding.where(system='http://hl7.org/fhir/sid/icd-10-cm' and code='${c.icd10Code ?? ''}').exists()`;
    case 'demographic':
      if (c.demographicField === 'age') {
        return `(today() - Patient.birthDate).value ${c.demographicOperator ?? '>='} ${c.demographicValue ?? ''}`;
      }
      // SES - assumes an extension carries a socioeconomic status code
      return `Patient.extension.where(url='http://example.org/fhir/StructureDefinition/socioeconomic-status').value.coding.code = '${c.demographicValue ?? ''}'`;
    default:
      return '';
  }
}

function buildCombinedExpression(conditions: RuleCondition[]): string {
  if (conditions.length === 0) {
    return '';
  }
  return conditions
    .map((c, idx) => {
      const expr = `(${buildExpressionForCondition(c)})`;
      if (idx === 0) {
        return expr;
      }
      return ` ${c.connector.toLowerCase()} ${expr}`;
    })
    .join('');
}

// ---- PlanDefinition.action generation -----------------------------------

function buildPlanDefinitionAction(action: RuleAction, combinedExpression: string): PlanDefinitionAction {
  const base: PlanDefinitionAction = {
    condition: [
      {
        kind: 'applicability',
        expression: {
          language: 'text/fhirpath',
          expression: combinedExpression,
        },
      },
    ],
  };

  switch (action.kind) {
    case 'task':
      return {
        ...base,
        title: action.taskTitle || 'Care Team Task',
        description: action.taskMessage || undefined,
        priority: action.taskPriority,
        definitionCanonical: 'ActivityDefinition/care-team-task',
      };
    case 'sms':
      return {
        ...base,
        title: 'Send SMS to Patient',
        description: action.smsMessage || undefined,
        definitionCanonical: 'ActivityDefinition/send-patient-sms',
      };
    case 'email':
      return {
        ...base,
        title: action.emailSubject || 'Send Email to Patient',
        description: action.emailMessage || undefined,
        definitionCanonical: 'ActivityDefinition/send-patient-email',
      };
    default:
      return base;
  }
}

// ---- Component ---------------------------------------------------------

export function RuleBuilderPage(): JSX.Element {
  const medplum = useMedplum();
  const navigate = useNavigate();
  const [loading, setLoading] = useState(false);

  const [ruleName, setRuleName] = useState('High Temperature Medication Alert');
  const [conditions, setConditions] = useState<RuleCondition[]>([
    newCondition(),
    { ...newCondition('AND'), kind: 'medication', medicationCode: '284399' },
  ]);
  const [actions, setActions] = useState<RuleAction[]>([newAction()]);

  const updateCondition = (id: string, patch: Partial<RuleCondition>): void => {
    setConditions((prev) => prev.map((c) => (c.id === id ? { ...c, ...patch } : c)));
  };

  const removeCondition = (id: string): void => {
    setConditions((prev) => prev.filter((c) => c.id !== id));
  };

  const addCondition = (): void => {
    setConditions((prev) => [...prev, newCondition('AND')]);
  };

  const updateAction = (id: string, patch: Partial<RuleAction>): void => {
    setActions((prev) => prev.map((a) => (a.id === id ? { ...a, ...patch } : a)));
  };

  const removeAction = (id: string): void => {
    setActions((prev) => prev.filter((a) => a.id !== id));
  };

  const addAction = (): void => {
    setActions((prev) => [...prev, newAction()]);
  };

  const handleSubmit = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    setLoading(true);

    const combinedExpression = buildCombinedExpression(conditions);

    const planDefinition: PlanDefinition = {
      resourceType: 'PlanDefinition',
      status: 'active',
      title: ruleName,
      type: {
        coding: [{ system: 'http://terminology.hl7.org/CodeSystem/plan-definition-type', code: 'eca-rule' }],
      },
      action: actions.map((a) => buildPlanDefinitionAction(a, combinedExpression)),
    };

    try {
      const result = await medplum.createResource(planDefinition);
      showNotification({
        color: 'green',
        title: 'Success',
        message: 'Rule created successfully!',
      });
      navigate('/PlanDefinition/' + result.id);
    } catch (err) {
      showNotification({
        color: 'red',
        title: 'Error creating rule',
        message: normalizeErrorString(err),
        autoClose: false,
      });
    } finally {
      setLoading(false);
    }
  };

  return (
    <Document shadow="xs">
      <form onSubmit={handleSubmit}>
        <Stack spacing="md">
          <Title order={3}>Create Automation Rule</Title>
          <Text color="dimmed" size="sm">
            Configure an automated rule made of any number of conditions, chained with AND / OR, that runs
            automatically when patient data changes.
          </Text>

          <TextInput
            label="Rule Name"
            required
            value={ruleName}
            onChange={(e) => setRuleName(e.currentTarget.value)}
          />

          {/* ---- Conditions ---- */}
          <Stack spacing="sm" style={{ background: '#f8f9fa', padding: '16px', borderRadius: '8px' }}>
            <Text fw={600} size="sm">
              Rule Conditions:
            </Text>

            {conditions.map((c, idx) => (
              <Stack key={c.id} spacing="xs" style={{ background: 'white', padding: '12px', borderRadius: '6px' }}>
                <Group position="apart">
                  {idx === 0 ? (
                    <Text component="span" fw={700} color="blue" size="sm">
                      IF
                    </Text>
                  ) : (
                    <Select
                      w={100}
                      value={c.connector}
                      onChange={(val) => updateCondition(c.id, { connector: (val as Connector) || 'AND' })}
                      data={[
                        { value: 'AND', label: 'AND' },
                        { value: 'OR', label: 'OR' },
                      ]}
                    />
                  )}
                  <ActionIcon color="red" variant="subtle" onClick={() => removeCondition(c.id)}>
                    <IconTrash size={16} />
                  </ActionIcon>
                </Group>

                <Select
                  label="Condition type"
                  value={c.kind}
                  onChange={(val) => {
                    const kind = (val as ConditionKind) || 'observation';
                    // reset kind-specific fields with sensible defaults
                    if (kind === 'observation') {
                      updateCondition(c.id, { kind, observationType: 'temperature', operator: '>', value: 90 });
                    } else if (kind === 'medication') {
                      updateCondition(c.id, { kind, medicationCode: '284399' });
                    } else if (kind === 'clinicalCondition') {
                      updateCondition(c.id, { kind, icd10Code: 'J45.909' }); // Asthma, unspecified
                    } else {
                      updateCondition(c.id, {
                        kind,
                        demographicField: 'age',
                        demographicOperator: '>=',
                        demographicValue: '65',
                      });
                    }
                  }}
                  data={[
                    { value: 'observation', label: 'Environmental Observation' },
                    { value: 'medication', label: 'Medication Prescribed' },
                    { value: 'clinicalCondition', label: 'Patient Has Condition' },
                    { value: 'demographic', label: 'Patient Demographic' },
                  ]}
                />

                {c.kind === 'observation' && (
                  <>
                    <Select
                      label="Observation type"
                      value={c.observationType ?? 'temperature'}
                      onChange={(val) =>
                        updateCondition(c.id, { observationType: (val as ObservationType) || 'temperature' })
                      }
                      data={[
                        { value: 'temperature', label: 'Temperature' },
                        { value: 'heatIndex', label: 'Heat Index' },
                      ]}
                    />
                    <Group grow>
                      <Select
                        label="Operator"
                        value={c.operator ?? '>'}
                        onChange={(val) => updateCondition(c.id, { operator: (val as ObservationOperator) || '>' })}
                        data={[
                          { value: '>', label: 'greater than' },
                          { value: '<', label: 'less than' },
                          { value: '>=', label: 'greater or equal' },
                          { value: '<=', label: 'less or equal' },
                          { value: '=', label: 'equal to' },
                        ]}
                      />
                      <NumberInput
                        label="Threshold value"
                        required
                        value={c.value ?? 0}
                        onChange={(val) => updateCondition(c.id, { value: typeof val === 'number' ? val : 0 })}
                        suffix=" °F"
                      />
                    </Group>
                  </>
                )}

                {c.kind === 'medication' && (
                  <TextInput
                    label="RxNorm code"
                    required
                    placeholder="e.g., 284399"
                    value={c.medicationCode ?? ''}
                    onChange={(e) => updateCondition(c.id, { medicationCode: e.currentTarget.value })}
                  />
                )}

                {c.kind === 'clinicalCondition' && (
                  <TextInput
                    label="ICD-10 code"
                    required
                    placeholder="e.g., J45.909 (Asthma, unspecified)"
                    value={c.icd10Code ?? ''}
                    onChange={(e) => updateCondition(c.id, { icd10Code: e.currentTarget.value })}
                  />
                )}

                {c.kind === 'demographic' && (
                  <>
                    <Select
                      label="Demographic field"
                      value={c.demographicField ?? 'age'}
                      onChange={(val) =>
                        updateCondition(c.id, { demographicField: (val as DemographicField) || 'age' })
                      }
                      data={[
                        { value: 'age', label: 'Age' },
                        { value: 'ses', label: 'Socioeconomic Status' },
                      ]}
                    />
                    {c.demographicField === 'age' ? (
                      <Group grow>
                        <Select
                          label="Operator"
                          value={c.demographicOperator ?? '>='}
                          onChange={(val) =>
                            updateCondition(c.id, { demographicOperator: (val as ObservationOperator) || '>=' })
                          }
                          data={[
                            { value: '>', label: 'greater than' },
                            { value: '<', label: 'less than' },
                            { value: '>=', label: 'greater or equal' },
                            { value: '<=', label: 'less or equal' },
                            { value: '=', label: 'equal to' },
                          ]}
                        />
                        <TextInput
                          label="Age (years)"
                          value={c.demographicValue ?? ''}
                          onChange={(e) => updateCondition(c.id, { demographicValue: e.currentTarget.value })}
                        />
                      </Group>
                    ) : (
                      <Select
                        label="Socioeconomic status"
                        value={c.demographicValue ?? 'low'}
                        onChange={(val) => updateCondition(c.id, { demographicValue: val || 'low' })}
                        data={[
                          { value: 'low', label: 'Low SES' },
                          { value: 'medium', label: 'Medium SES' },
                          { value: 'high', label: 'High SES' },
                        ]}
                      />
                    )}
                  </>
                )}
              </Stack>
            ))}

            <Button
              variant="light"
              leftIcon={<IconPlus size={16} />}
              onClick={addCondition}
              style={{ alignSelf: 'flex-start' }}
            >
              Add Condition
            </Button>
          </Stack>

          <Divider my="xs" />

          {/* ---- Actions ---- */}
          <Stack spacing="sm" style={{ background: '#f8f9fa', padding: '16px', borderRadius: '8px' }}>
            <Text fw={600} size="sm">
              Actions to take (THEN):
            </Text>

            {actions.map((a) => (
              <Stack key={a.id} spacing="xs" style={{ background: 'white', padding: '12px', borderRadius: '6px' }}>
                <Group position="apart">
                  <Text component="span" fw={700} color="blue" size="sm">
                    THEN
                  </Text>
                  <ActionIcon
                    color="red"
                    variant="subtle"
                    onClick={() => removeAction(a.id)}
                    disabled={actions.length === 1}
                  >
                    <IconTrash size={16} />
                  </ActionIcon>
                </Group>

                <Select
                  label="Action type"
                  value={a.kind}
                  onChange={(val) => {
                    const kind = (val as ActionKind) || 'task';
                    if (kind === 'task') {
                      updateAction(a.id, {
                        kind,
                        taskTitle: 'Follow up with patient',
                        taskPriority: 'routine',
                        taskMessage: '',
                      });
                    } else if (kind === 'sms') {
                      updateAction(a.id, { kind, smsMessage: '' });
                    } else {
                      updateAction(a.id, { kind, emailSubject: '', emailMessage: '' });
                    }
                  }}
                  data={[
                    { value: 'task', label: 'Create a Task for the Care Team' },
                    { value: 'sms', label: 'Send an SMS to the Patient' },
                    { value: 'email', label: 'Send an Email to the Patient' },
                  ]}
                />

                {a.kind === 'task' && (
                  <>
                    <TextInput
                      label="Task title"
                      required
                      value={a.taskTitle ?? ''}
                      onChange={(e) => updateAction(a.id, { taskTitle: e.currentTarget.value })}
                    />
                    <Select
                      label="Priority"
                      value={a.taskPriority ?? 'routine'}
                      onChange={(val) => updateAction(a.id, { taskPriority: (val as TaskPriority) || 'routine' })}
                      data={[
                        { value: 'routine', label: 'Routine' },
                        { value: 'urgent', label: 'Urgent' },
                        { value: 'asap', label: 'ASAP' },
                        { value: 'stat', label: 'STAT' },
                      ]}
                    />
                    <Textarea
                      label="Instructions for care team"
                      placeholder="e.g., Check in on patient's hydration and medication adherence given the heat advisory."
                      autosize
                      minRows={2}
                      value={a.taskMessage ?? ''}
                      onChange={(e) => updateAction(a.id, { taskMessage: e.currentTarget.value })}
                    />
                  </>
                )}

                {a.kind === 'sms' && (
                  <Textarea
                    label="SMS message to patient"
                    required
                    placeholder="e.g., It's very hot today — please stay hydrated and take your medication as prescribed."
                    autosize
                    minRows={2}
                    value={a.smsMessage ?? ''}
                    onChange={(e) => updateAction(a.id, { smsMessage: e.currentTarget.value })}
                  />
                )}

                {a.kind === 'email' && (
                  <>
                    <TextInput
                      label="Email subject"
                      required
                      value={a.emailSubject ?? ''}
                      onChange={(e) => updateAction(a.id, { emailSubject: e.currentTarget.value })}
                    />
                    <Textarea
                      label="Email message"
                      required
                      autosize
                      minRows={3}
                      value={a.emailMessage ?? ''}
                      onChange={(e) => updateAction(a.id, { emailMessage: e.currentTarget.value })}
                    />
                  </>
                )}
              </Stack>
            ))}

            <Button
              variant="light"
              leftIcon={<IconPlus size={16} />}
              onClick={addAction}
              style={{ alignSelf: 'flex-start' }}
            >
              Add Action
            </Button>
          </Stack>

          <Button type="submit" loading={loading} style={{ alignSelf: 'flex-start' }}>
            Save Automation Rule
          </Button>
        </Stack>
      </form>
    </Document>
  );
}