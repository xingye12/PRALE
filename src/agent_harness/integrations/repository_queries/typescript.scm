(class_declaration name: (type_identifier) @name) @definition.class

(function_declaration name: (identifier) @name) @definition.function

(method_definition name: (property_identifier) @name) @definition.method

(interface_declaration name: (type_identifier) @name) @definition.interface

(call_expression function: [(identifier) @name (member_expression property: (property_identifier) @name)]) @reference.call
