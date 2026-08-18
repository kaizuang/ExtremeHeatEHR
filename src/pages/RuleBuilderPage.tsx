// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
import {
  ActionIcon,
  Button,
  Checkbox,
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
type DemographicField = 'age' | 'race';
type ObservationType = 'temperature' | 'heatIndex';
// Which FHIR resource(s) count as "active medication" for a medication condition.
// A prescription (MedicationRequest) is not always the same as confirmed patient use
// (MedicationStatement), so the rule builder lets the user pick.
type MedicationSource = 'request' | 'statement' | 'both';

// A rule is a tree of nodes. A node is either a single condition (leaf) or a group
// (a nested set of conditions/groups joined by their own internal AND/OR/NOT logic).
// This is what allows compound rules such as:
//   (temperature > 100 AND medication is methadone) OR (temperature > 90 AND medication is oxycontin)
// where each parenthesized clause is a group, and the groups themselves are joined by OR.
type RuleNode = RuleCondition | RuleConditionGroup;

interface BaseRuleNode {
  id: string;
  connector: Connector; // connector joining this node to the PREVIOUS sibling (ignored for first item in a list)
  negate?: boolean; // if true, this node's expression is wrapped in NOT(...)
}

interface RuleCondition extends BaseRuleNode {
  type: 'condition';
  kind: ConditionKind;

  // observation fields
  observationType?: ObservationType;
  operator?: ObservationOperator;
  value?: number;

  // medication fields — RxNorm only (standard US medication coding system)
  medicationCode?: string; // RxNorm code, e.g. "284399"
  medicationSource?: MedicationSource;

  // clinical condition fields — ICD-10-CM only (standard US diagnosis coding system)
  // Note: this can also capture SDOH data, since SDOH factors (e.g. housing instability,
  // food insecurity) are often encoded as ICD-10-CM Z-codes.
  icd10Code?: string; // e.g. "J45.909" (Asthma, unspecified)

  // demographic fields
  demographicField?: DemographicField;
  demographicOperator?: ObservationOperator;
  demographicValue?: string; // age number, race code, or SES level, as a string
}

interface RuleConditionGroup extends BaseRuleNode {
  type: 'group';
  children: RuleNode[];
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
    type: 'condition',
    kind: 'observation',
    connector,
    negate: false,
    observationType: 'temperature',
    operator: '>',
    value: 90,
  };
}

function newGroup(connector: Connector = 'AND'): RuleConditionGroup {
  return {
    id: makeId(),
    type: 'group',
    connector,
    negate: false,
    children: [newCondition()],
  };
}

// ---- Tree helpers --------------------------------------------------
// The rule is stored as an array of sibling RuleNodes (the implicit top-level group),
// where each group node nests its own array of children. These helpers walk the tree
// to update, remove, or insert a node by id, wherever it lives in the nesting.

function updateNodeInTree(nodes: RuleNode[], id: string, patch: Partial<RuleNode>): RuleNode[] {
  return nodes.map((n) => {
    if (n.id === id) {
      return { ...n, ...patch } as RuleNode;
    }
    if (n.type === 'group') {
      return { ...n, children: updateNodeInTree(n.children, id, patch) };
    }
    return n;
  });
}

function removeNodeFromTree(nodes: RuleNode[], id: string): RuleNode[] {
  return nodes
    .filter((n) => n.id !== id)
    .map((n) => (n.type === 'group' ? { ...n, children: removeNodeFromTree(n.children, id) } : n));
}

function addChildToGroup(nodes: RuleNode[], groupId: string, child: RuleNode): RuleNode[] {
  return nodes.map((n) => {
    if (n.id === groupId && n.type === 'group') {
      return { ...n, children: [...n.children, child] };
    }
    if (n.type === 'group') {
      return { ...n, children: addChildToGroup(n.children, groupId, child) };
    }
    return n;
  });
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

// ---- Reference data ------------------------------------------------

// OMB race categories, used with the US Core race extension.
const RACE_OPTIONS = [
  { value: '1002-5', label: 'American Indian or Alaska Native' },
  { value: '2028-9', label: 'Asian' },
  { value: '2054-5', label: 'Black or African American' },
  { value: '2076-8', label: 'Native Hawaiian or Other Pacific Islander' },
  { value: '2106-3', label: 'White' },
  { value: 'UNK', label: 'Unknown / Other' },
];

// ---- FHIRPath generation ----------------------------------------------

function buildExpressionForCondition(c: RuleCondition): string {
  let expr: string;

  switch (c.kind) {
    case 'observation':
      expr = `Observation.where(code.text='${c.observationType}').valueQuantity.value ${c.operator ?? '>'} ${c.value ?? 0}`;
      break;

    case 'medication': {
      const rxCode = c.medicationCode ?? '';
      const requestExpr = `MedicationRequest.medicationCodeableConcept.coding.where(system='http://www.nlm.nih.gov/research/umls/rxnorm' and code='${rxCode}').exists()`;
      const statementExpr = `MedicationStatement.medicationCodeableConcept.coding.where(system='http://www.nlm.nih.gov/research/umls/rxnorm' and code='${rxCode}').exists()`;
      const source = c.medicationSource ?? 'request';
      if (source === 'request') {
        expr = requestExpr;
      } else if (source === 'statement') {
        expr = statementExpr;
      } else {
        expr = `(${requestExpr}) or (${statementExpr})`;
      }
      break;
    }

    case 'clinicalCondition':
      expr = `Condition.code.coding.where(system='http://hl7.org/fhir/sid/icd-10-cm' and code='${c.icd10Code ?? ''}').exists()`;
      break;

    case 'demographic':
      if (c.demographicField === 'age') {
        expr = `(today() - Patient.birthDate).value ${c.demographicOperator ?? '>='} ${c.demographicValue ?? ''}`;
      } else if (c.demographicField === 'race') {
        expr = `Patient.extension.where(url='http://hl7.org/fhir/us/core/StructureDefinition/us-core-race').extension.where(url='ombCategory').value.coding.code = '${c.demographicValue ?? ''}'`;
      }
      break;

    default:
      expr = '';
  }

  return c.negate ? `not(${expr})` : expr;
}

function nodeExpression(node: RuleNode): string {
  if (node.type === 'condition') {
    return buildExpressionForCondition(node);
  }
  // group: combine children, then optionally negate the whole group
  const inner = buildCombinedExpression(node.children);
  return node.negate ? `not(${inner})` : inner;
}

function buildCombinedExpression(nodes: RuleNode[]): string {
  if (nodes.length === 0) {
    return '';
  }
  return nodes
    .map((n, idx) => {
      const expr = `(${nodeExpression(n)})`;
      if (idx === 0) {
        return expr;
      }
      return ` ${n.connector.toLowerCase()} ${expr}`;
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

// ---- Leaf condition fields ----------------------------------------------
// Renders the "Condition type" selector plus whichever kind-specific fields
// apply (observation / medication / clinicalCondition / demographic).
function ConditionKindFields({
  c,
  onUpdate,
}: {
  c: RuleCondition;
  onUpdate: (patch: Partial<RuleCondition>) => void;
}): JSX.Element {
  return (
    <>
      <Select
        label="Condition type"
        value={c.kind}
        onChange={(val) => {
          const kind = (val as ConditionKind) || 'observation';
          // reset kind-specific fields with sensible defaults
          if (kind === 'observation') {
            onUpdate({ kind, observationType: 'temperature', operator: '>', value: 90 });
          } else if (kind === 'medication') {
            onUpdate({ kind, medicationCode: '284399', medicationSource: 'request' });
          } else if (kind === 'clinicalCondition') {
            onUpdate({ kind, icd10Code: 'J45.909' }); // Asthma, unspecified
          } else {
            onUpdate({
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
            onChange={(val) => onUpdate({ observationType: (val as ObservationType) || 'temperature' })}
            data={[
              { value: 'temperature', label: 'Temperature' },
              { value: 'heatIndex', label: 'Heat Index' },
            ]}
          />
          <Group grow>
            <Select
              label="Operator"
              value={c.operator ?? '>'}
              onChange={(val) => onUpdate({ operator: (val as ObservationOperator) || '>' })}
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
              onChange={(val) => onUpdate({ value: typeof val === 'number' ? val : 0 })}
              suffix=" °F"
            />
          </Group>
        </>
      )}

      {c.kind === 'medication' && (
        <>
          <TextInput
            label="RxNorm code"
            required
            placeholder="e.g., 284399"
            value={c.medicationCode ?? ''}
            onChange={(e) => onUpdate({ medicationCode: e.currentTarget.value })}
          />
          <Select
            label="Counts as active if found in"
            value={c.medicationSource ?? 'request'}
            onChange={(val) => onUpdate({ medicationSource: (val as MedicationSource) || 'request' })}
            data={[
              { value: 'request', label: 'Prescriptions (MedicationRequest)' },
              { value: 'statement', label: 'Reported use (MedicationStatement)' },
              { value: 'both', label: 'Either prescriptions or reported use' },
            ]}
          />
          <Text size="xs" color="dimmed">
            Note: there is currently no way to flag a whole drug class (e.g. opioids). To match a class, add one
            condition per medication (e.g. morphine, oxycontin, methadone) joined with OR.
          </Text>
        </>
      )}

      {c.kind === 'clinicalCondition' && (
        <>
          <TextInput
            label="ICD-10 code"
            required
            placeholder="e.g., J45.909 (Asthma, unspecified)"
            value={c.icd10Code ?? ''}
            onChange={(e) => onUpdate({ icd10Code: e.currentTarget.value })}
          />
          <Text size="xs" color="dimmed">
            This can also capture SDOH factors encoded as ICD-10-CM Z-codes (e.g. Z59.0 for homelessness).
          </Text>
        </>
      )}

      {c.kind === 'demographic' && (
        <>
          <Select
            label="Demographic field"
            value={c.demographicField ?? 'age'}
            onChange={(val) => {
              const demographicField = (val as DemographicField) || 'age';
              if (demographicField === 'age') {
                onUpdate({ demographicField, demographicOperator: '>=', demographicValue: '65' });
              } else if (demographicField === 'race') {
                onUpdate({ demographicField, demographicValue: RACE_OPTIONS[0].value });
              } else {
                onUpdate({ demographicField, demographicValue: 'low' });
              }
            }}
            data={[
              { value: 'age', label: 'Age' },
              { value: 'race', label: 'Race' },
            ]}
          />
          {c.demographicField === 'age' && (
            <Group grow>
              <Select
                label="Operator"
                value={c.demographicOperator ?? '>='}
                onChange={(val) => onUpdate({ demographicOperator: (val as ObservationOperator) || '>=' })}
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
                onChange={(e) => onUpdate({ demographicValue: e.currentTarget.value })}
              />
            </Group>
          )}
          {c.demographicField === 'race' && (
            <Select
              label="Race"
              value={c.demographicValue ?? RACE_OPTIONS[0].value}
              onChange={(val) => onUpdate({ demographicValue: val || RACE_OPTIONS[0].value })}
              data={RACE_OPTIONS}
            />
          )}
        </>
      )}
    </>
  );
}

// ---- Recursive node editor ----------------------------------------------
// Renders a single RuleNode: its connector/NOT/remove header, and either its
// leaf condition fields, or (for a group) a nested, indented RuleNodeList
// plus buttons to add more conditions/groups inside that group.
function RuleNodeEditor({
  node,
  isFirst,
  onUpdate,
  onRemove,
  onAddCondition,
  onAddGroup,
}: {
  node: RuleNode;
  isFirst: boolean;
  onUpdate: (id: string, patch: Partial<RuleNode>) => void;
  onRemove: (id: string) => void;
  onAddCondition: (groupId: string) => void;
  onAddGroup: (groupId: string) => void;
}): JSX.Element {
  const isGroup = node.type === 'group';

  return (
    <Stack
      spacing="xs"
      style={{
        background: isGroup ? '#eef2ff' : 'white',
        padding: '12px',
        borderRadius: '6px',
        border: isGroup ? '1px dashed #7c86ff' : undefined,
      }}
    >
      <Group position="apart">
        {isFirst ? (
          <Text component="span" fw={700} color="blue" size="sm">
            IF
          </Text>
        ) : (
          <Select
            w={100}
            value={node.connector}
            onChange={(val) => onUpdate(node.id, { connector: (val as Connector) || 'AND' })}
            data={[
              { value: 'AND', label: 'AND' },
              { value: 'OR', label: 'OR' },
            ]}
          />
        )}
        <Group spacing="xs">
          {isGroup && (
            <Text size="xs" color="dimmed">
              Group
            </Text>
          )}
          <Checkbox
            label="NOT"
            checked={node.negate ?? false}
            onChange={(e) => onUpdate(node.id, { negate: e.currentTarget.checked })}
          />
          <ActionIcon color="red" variant="subtle" onClick={() => onRemove(node.id)}>
            <IconTrash size={16} />
          </ActionIcon>
        </Group>
      </Group>

      {node.type === 'condition' ? (
        <ConditionKindFields c={node} onUpdate={(patch) => onUpdate(node.id, patch)} />
      ) : (
        <Stack spacing="xs" pl="md" style={{ borderLeft: '2px solid #7c86ff' }}>
          <RuleNodeList
            nodes={node.children}
            onUpdate={onUpdate}
            onRemove={onRemove}
            onAddCondition={onAddCondition}
            onAddGroup={onAddGroup}
          />
          <Group spacing="xs">
            <Button
              variant="subtle"
              size="xs"
              leftIcon={<IconPlus size={14} />}
              onClick={() => onAddCondition(node.id)}
              style={{ alignSelf: 'flex-start' }}
            >
              Add Condition
            </Button>
            <Button
              variant="subtle"
              size="xs"
              leftIcon={<IconPlus size={14} />}
              onClick={() => onAddGroup(node.id)}
              style={{ alignSelf: 'flex-start' }}
            >
              Add Nested Group
            </Button>
          </Group>
        </Stack>
      )}
    </Stack>
  );
}

// Renders a sibling list of RuleNodes (used for the root list and for each group's children).
function RuleNodeList({
  nodes,
  onUpdate,
  onRemove,
  onAddCondition,
  onAddGroup,
}: {
  nodes: RuleNode[];
  onUpdate: (id: string, patch: Partial<RuleNode>) => void;
  onRemove: (id: string) => void;
  onAddCondition: (groupId: string) => void;
  onAddGroup: (groupId: string) => void;
}): JSX.Element {
  return (
    <>
      {nodes.map((node, idx) => (
        <RuleNodeEditor
          key={node.id}
          node={node}
          isFirst={idx === 0}
          onUpdate={onUpdate}
          onRemove={onRemove}
          onAddCondition={onAddCondition}
          onAddGroup={onAddGroup}
        />
      ))}
    </>
  );
}

export function RuleBuilderPage(): JSX.Element {
  const medplum = useMedplum();
  const navigate = useNavigate();
  const [loading, setLoading] = useState(false);

  const [ruleName, setRuleName] = useState('High Temperature Medication Alert');
  // The top-level array acts as an implicit root group — no connector/remove/NOT controls
  // are shown for it, but each item in it (leaf condition or nested group) can itself be
  // combined with AND/OR/NOT, and groups can be nested arbitrarily deep.
  const [conditions, setConditions] = useState<RuleNode[]>([
    newCondition(),
    { ...newCondition('AND'), kind: 'medication', medicationCode: '284399', medicationSource: 'request' },
  ]);
  const [actions, setActions] = useState<RuleAction[]>([newAction()]);

  const updateNode = (id: string, patch: Partial<RuleNode>): void => {
    setConditions((prev) => updateNodeInTree(prev, id, patch));
  };

  const removeNode = (id: string): void => {
    setConditions((prev) => removeNodeFromTree(prev, id));
  };

  const addConditionToRoot = (): void => {
    setConditions((prev) => [...prev, newCondition('AND')]);
  };

  const addGroupToRoot = (): void => {
    setConditions((prev) => [...prev, newGroup('AND')]);
  };

  const addConditionToGroup = (groupId: string): void => {
    setConditions((prev) => addChildToGroup(prev, groupId, newCondition('AND')));
  };

  const addGroupToGroup = (groupId: string): void => {
    setConditions((prev) => addChildToGroup(prev, groupId, newGroup('AND')));
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
            Configure an automated rule made of any number of conditions, chained with AND / OR / NOT, that runs
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
            <Text size="xs" color="dimmed">
              Add a "Group" to nest conditions in parentheses — e.g. (temperature &gt; 100 AND medication is
              methadone) OR (temperature &gt; 90 AND medication is oxycontin).
            </Text>

            <RuleNodeList
              nodes={conditions}
              onUpdate={updateNode}
              onRemove={removeNode}
              onAddCondition={addConditionToGroup}
              onAddGroup={addGroupToGroup}
            />

            <Group spacing="xs">
              <Button
                variant="light"
                leftIcon={<IconPlus size={16} />}
                onClick={addConditionToRoot}
                style={{ alignSelf: 'flex-start' }}
              >
                Add Condition
              </Button>
              <Button
                variant="default"
                leftIcon={<IconPlus size={16} />}
                onClick={addGroupToRoot}
                style={{ alignSelf: 'flex-start' }}
              >
                Add Group
              </Button>
            </Group>
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