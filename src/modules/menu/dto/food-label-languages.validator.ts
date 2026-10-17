import { registerDecorator, type ValidationArguments, type ValidationOptions, ValidatorConstraint, type ValidatorConstraintInterface } from 'class-validator';

@ValidatorConstraint({ name: 'foodLabelLanguages', async: false })
class FoodLabelLanguagesConstraint implements ValidatorConstraintInterface {
  validate(value: unknown, args: ValidationArguments): boolean {
    const [baseField] = args.constraints as [string];
    const labels = (args.object as Record<string, unknown>)[baseField];
    // Partial updates may omit all three arrays. If labels are supplied, each
    // language must be supplied in the same order and with no blank entries.
    if (labels === undefined) return value === undefined;
    if (!Array.isArray(labels) || labels.length === 0) return value === undefined || (Array.isArray(value) && value.length === 0);
    return Array.isArray(value)
      && value.length === labels.length
      && value.every((label) => typeof label === 'string' && label.trim().length > 0);
  }

  defaultMessage(args: ValidationArguments): string {
    const [baseField] = args.constraints as [string];
    return `${args.property} must contain a non-empty translation for every ${baseField} label, in the same order.`;
  }
}

export function MatchesFoodLabelLanguages(baseField: string, options?: ValidationOptions): PropertyDecorator {
  return (target, propertyName) => registerDecorator({
    name: 'foodLabelLanguages',
    target: target.constructor,
    propertyName: propertyName.toString(),
    constraints: [baseField],
    options,
    validator: FoodLabelLanguagesConstraint,
  });
}
