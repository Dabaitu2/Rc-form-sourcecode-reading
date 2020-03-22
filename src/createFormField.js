class Field {
  // 通过这种方式，不需要把参数写的贼复杂再很麻烦的传进来
  // 而且传optional的东西也很方便，特别是和范型结合的话
  // 用于设置成员变量
  constructor(fields) {
    Object.assign(this, fields);
  }
}

function isFormField(obj) {
  return obj instanceof Field;
}

export default function createFormField(field) {
  if (isFormField(field)) {
    return field;
  }
  return new Field(field);
}

