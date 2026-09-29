(class_declaration name: (identifier) @name) @definition.class

(function_declaration name: (identifier) @name) @definition.function

(method_definition name: (property_identifier) @name) @definition.method

(variable_declarator name: (identifier) @name) @definition.variable

(call_expression function: [(identifier) @name (member_expression property: (property_identifier) @name)]) @reference.call
