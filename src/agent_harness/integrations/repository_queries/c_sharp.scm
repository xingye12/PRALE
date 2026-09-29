(class_declaration name: (identifier) @name) @definition.class

(interface_declaration name: (identifier) @name) @definition.interface

(method_declaration name: (identifier) @name) @definition.method

(invocation_expression function: [(identifier) @name (member_access_expression name: (identifier) @name)]) @reference.call
