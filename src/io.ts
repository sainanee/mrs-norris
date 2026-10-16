import { confirm, input } from '@inquirer/prompts';

export interface IO {
  print(msg: string): void;
  confirm(msg: string): Promise<boolean>;
  input(msg: string, defaultValue: string): Promise<string>;
}

export function consoleIO(): IO {
  return {
    print: (msg) => console.log(msg),
    confirm: (message) => confirm({ message }),
    input: (message, defaultValue) => input({ message, default: defaultValue }),
  };
}
