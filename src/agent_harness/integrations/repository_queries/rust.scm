(function_item name: (identifier) @name) @definition.function

(struct_item name: (type_identifier) @name) @definition.class

(trait_item name: (type_identifier) @name) @definition.interface

(call_expression function: [(identifier) @name (field_expression field: (field_identifier) @name)]) @reference.call
