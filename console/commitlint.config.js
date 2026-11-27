import conventional from '@commitlint/config-conventional'

const [level, applicable, types] = conventional.rules['type-enum']

export default {
  extends: ['@commitlint/config-conventional'],
  rules: {
    'body-max-line-length': [0],
    'type-enum': [level, applicable, [...types, 'release', 'wip']],
  },
}
