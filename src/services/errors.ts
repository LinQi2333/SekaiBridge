/** 业务层错误：QQ 命令处理器与未来 Web 层都可以捕获并格式化。 */

export class NotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NotFoundError';
  }
}

export class ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ValidationError';
  }
}

export class AlreadyExistsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AlreadyExistsError';
  }
}

export class IllegalTransitionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'IllegalTransitionError';
  }
}

/** 阶段尚未实现的占位错误。 */
export class NotImplementedError extends Error {
  constructor(feature: string) {
    super(`${feature} 在后续阶段实现（见开发阶段规划）`);
    this.name = 'NotImplementedError';
  }
}
