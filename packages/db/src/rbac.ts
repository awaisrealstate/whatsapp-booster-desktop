import type { OrgRole } from './schema.ts';

export type Permission =
  | 'org:manage_settings'
  | 'org:manage_billing'
  | 'team:manage'
  | 'team:invite'
  | 'team:read'
  | 'crm:write'
  | 'crm:read'
  | 'inbox:reply'
  | 'whatsapp:manage'
  | 'campaigns:manage'
  | 'campaigns:read'
  | 'ai:manage'
  | 'ai:read'
  | 'audit:read';

const ROLE_PERMISSIONS: Record<OrgRole, ReadonlySet<Permission>> = {
  owner: new Set<Permission>([
    'org:manage_settings',
    'org:manage_billing',
    'team:manage',
    'team:invite',
    'team:read',
    'crm:write',
    'crm:read',
    'inbox:reply',
    'whatsapp:manage',
    'campaigns:manage',
    'campaigns:read',
    'ai:manage',
    'ai:read',
    'audit:read'
  ]),
  admin: new Set<Permission>([
    'org:manage_settings',
    'team:manage',
    'team:invite',
    'team:read',
    'crm:write',
    'crm:read',
    'inbox:reply',
    'whatsapp:manage',
    'campaigns:manage',
    'campaigns:read',
    'ai:manage',
    'ai:read',
    'audit:read'
  ]),
  manager: new Set<Permission>([
    'team:read',
    'crm:write',
    'crm:read',
    'inbox:reply',
    'whatsapp:manage',
    'campaigns:manage',
    'campaigns:read',
    'ai:manage',
    'ai:read'
  ]),
  agent: new Set<Permission>([
    'team:read',
    'crm:read',
    'crm:write',
    'inbox:reply',
    'campaigns:read',
    'ai:read'
  ]),
  viewer: new Set<Permission>(['team:read', 'crm:read', 'campaigns:read', 'ai:read'])
};

export function hasPermission(role: OrgRole, permission: Permission): boolean {
  return ROLE_PERMISSIONS[role]?.has(permission) ?? false;
}

export function getRolePermissions(role: OrgRole): Permission[] {
  return Array.from(ROLE_PERMISSIONS[role] ?? []);
}
