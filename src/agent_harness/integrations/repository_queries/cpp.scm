(function_definition declarator: (function_declarator declarator: (identifier) @name)) @definition.function

(class_specifier name: (type_identifier) @name) @definition.class

(call_expression function: [(identifier) @name (field_expression field: (field_identifier) @name)]) @reference.call
