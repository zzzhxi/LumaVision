export const REGISTRATION_EMAIL_DOMAINS = Object.freeze([
  { value: '163.com', label: '163 邮箱' },
  { value: 'qq.com', label: 'QQ 邮箱' },
  { value: 'gmail.com', label: 'Gmail' },
  { value: 'outlook.com', label: 'Outlook' },
  { value: '126.com', label: '126 邮箱' },
  { value: 'hotmail.com', label: 'Hotmail' }
]);

export const DEFAULT_REGISTRATION_EMAIL_DOMAIN = '163.com';
export const REGISTRATION_EMAIL_DOMAIN_VALUES = Object.freeze(REGISTRATION_EMAIL_DOMAINS.map(item => item.value));

export function emailDomain(value) {
  const email = String(value || '');
  const at = email.lastIndexOf('@');
  return at < 0 ? '' : email.slice(at + 1).toLowerCase();
}
