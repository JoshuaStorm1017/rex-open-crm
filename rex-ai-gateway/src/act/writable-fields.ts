export const UPDATABLE_FIELDS = {
  person: ['firstName', 'lastName', 'email', 'jobTitle'],
  company: ['name', 'domain'],
  opportunity: ['name', 'stage', 'amount'],
} as const;

export type UpdatableObjectName = keyof typeof UPDATABLE_FIELDS;

export const UPDATABLE_OBJECT_NAMES = Object.keys(
  UPDATABLE_FIELDS,
) as UpdatableObjectName[];

export function isUpdatableObjectName(value: string): value is UpdatableObjectName {
  return Object.prototype.hasOwnProperty.call(UPDATABLE_FIELDS, value);
}

export function isUpdatableField(
  objectName: UpdatableObjectName,
  field: string,
): boolean {
  return (UPDATABLE_FIELDS[objectName] as readonly string[]).includes(field);
}
